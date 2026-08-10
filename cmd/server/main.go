package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/CORTA-11/socket-server/internal/auth"
	"github.com/CORTA-11/socket-server/internal/bus"
	"github.com/CORTA-11/socket-server/internal/coreapi"
	"github.com/CORTA-11/socket-server/internal/hub"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type publishRequest struct {
	TeamID int64  `json:"team_id"`
	Type   string `json:"type"`
	Data   any    `json:"data"`
}

func main() {
	h := hub.New()
	go h.Run()

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	subscriber, err := bus.NewSubscriberFromEnv(h)
	if err != nil {
		log.Fatalf("redis subscriber failed (is Redis running?): %v", err)
	}
	defer func() { _ = subscriber.Close() }()
	go subscriber.Run(ctx)

	core := coreapi.NewFromEnv()
	internalKey := os.Getenv("INTERNAL_API_KEY")
	if internalKey == "" {
		internalKey = "dev-internal-key-change-me"
	}

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(corsMiddleware)

	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true,"bus":"redis"}`))
	})

	r.Get("/ws", func(w http.ResponseWriter, req *http.Request) {
		token := req.URL.Query().Get("token")
		teamPublicID := req.URL.Query().Get("team_id")
		if token == "" || teamPublicID == "" {
			http.Error(w, "token and team_id are required", http.StatusBadRequest)
			return
		}

		claims, err := auth.ValidateToken(token)
		if err != nil {
			http.Error(w, "invalid or expired token", http.StatusUnauthorized)
			return
		}

		if claims.OrgRole == "ORG_ADMIN" {
			http.Error(w, "forbidden: organization admins cannot access team chat", http.StatusForbidden)
			return
		}

		access, err := core.CheckTeamAccess(req.Context(), teamPublicID, claims.UserID)
		if err != nil {
			http.Error(w, "forbidden: not a team member", http.StatusForbidden)
			return
		}

		if access.OrgID != claims.OrgID {
			http.Error(w, "forbidden: wrong organization", http.StatusForbidden)
			return
		}

		hub.ServeWS(h, access.TeamID, claims.UserID, w, req)
	})

	// Optional debug inject (local only). Production path is Redis Pub/Sub from core-api.
	r.Post("/internal/publish", func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("X-Internal-Key") != internalKey {
			http.Error(w, "invalid internal key", http.StatusUnauthorized)
			return
		}

		var body publishRequest
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		if body.TeamID < 1 || body.Type == "" {
			http.Error(w, "team_id and type are required", http.StatusBadRequest)
			return
		}

		h.Publish(body.TeamID, hub.Event{
			Type: body.Type,
			Data: body.Data,
		})
		w.WriteHeader(http.StatusNoContent)
	})

	addr := ":8081"
	if v := os.Getenv("PORT"); v != "" {
		addr = ":" + v
	}

	server := &http.Server{Addr: addr, Handler: r}
	go func() {
		<-ctx.Done()
		_ = server.Shutdown(context.Background())
	}()

	log.Printf("socket-server listening on %s (redis pub/sub fan-out)", addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("socket-server failed: %v", err)
	}
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "http://localhost:3000" || origin == "http://127.0.0.1:3000" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
