package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/CORTA-11/socket-server/internal/auth"
	"github.com/CORTA-11/socket-server/internal/bus"
	"github.com/CORTA-11/socket-server/internal/hub"
	"github.com/CORTA-11/socket-server/internal/logging"
	"github.com/go-chi/chi/v5"
)

type publishRequest struct {
	TeamID int64  `json:"team_id"`
	Type   string `json:"type"`
	Data   any    `json:"data"`
}

func main() {
	logger := logging.New("socket-server")
	slog.SetDefault(logger)
	h := hub.New()
	go h.Run()

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	subscriber, err := bus.NewSubscriberFromEnv(h)
	if err != nil {
		logger.Error("redis subscriber failed", "error", err)
		os.Exit(1)
	}
	defer func() { _ = subscriber.Close() }()
	go subscriber.Run(ctx)

	internalKey := os.Getenv("INTERNAL_API_KEY")
	if internalKey == "" {
		internalKey = "dev-internal-key-change-me"
	}

	r := chi.NewRouter()
	r.Use(requestLog(logger))
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

		if teamPublicID != claims.TeamPublicID {
			http.Error(w, "forbidden: wrong team", http.StatusForbidden)
			return
		}

		hub.ServeWS(h, claims.TeamID, claims.UserID, w, req)
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

	logger.Info("socket-server listening", "addr", addr, "transport", "redis_pubsub")
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("socket-server failed", "error", err)
		os.Exit(1)
	}
}

func requestLog(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			started := time.Now()
			tracked := &responseWriter{ResponseWriter: w}
			next.ServeHTTP(tracked, r)
			status := tracked.status
			if status == 0 {
				status = http.StatusOK
			}
			logger.InfoContext(r.Context(), "http_request", "method", r.Method, "path", r.URL.Path, "status", status, "duration_ms", time.Since(started).Milliseconds(), "response_bytes", tracked.bytes)
		})
	}
}

type responseWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *responseWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *responseWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(body)
	w.bytes += n
	return n, err
}

func (w *responseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *responseWriter) Flush() {
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("response writer does not support hijacking")
	}
	return hijacker.Hijack()
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if hub.AllowsOrigin(origin) {
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
