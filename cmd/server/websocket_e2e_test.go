package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/CORTA-11/socket-server/internal/auth"
	"github.com/CORTA-11/socket-server/internal/hub"
	"github.com/gorilla/websocket"
)

func TestWebSocketAcceptsTicketAndReceivesRoomEvent(t *testing.T) {
	t.Setenv("JWT_SECRET", "socket-e2e-ticket-secret-with-enough-length")
	h := hub.New()
	go h.Run()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, err := auth.ValidateToken(r.URL.Query().Get("token"))
		if err != nil {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		if r.URL.Query().Get("team_id") != claims.TeamPublicID {
			http.Error(w, "wrong team", http.StatusForbidden)
			return
		}
		hub.ServeWS(h, claims.TeamID, claims.UserID, w, r)
	}))
	defer server.Close()

	token := signedTicket(t, map[string]any{
		"user_id":        "11111111-1111-4111-8111-111111111111",
		"org_id":         "22222222-2222-4222-8222-222222222222",
		"team_id":        42,
		"team_public_id": "33333333-3333-4333-8333-333333333333",
		"exp":            time.Now().Add(time.Minute).Unix(),
	})
	target := "ws" + strings.TrimPrefix(server.URL, "http") + "?team_id=33333333-3333-4333-8333-333333333333&token=" + token
	conn, _, err := websocket.DefaultDialer.Dial(target, nil)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()

	h.Publish(42, hub.Event{Type: "message.created", Data: map[string]any{"id": "message-1"}})
	_, payload, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read websocket message: %v", err)
	}
	if !strings.Contains(string(payload), `"message.created"`) {
		t.Fatalf("payload = %s", string(payload))
	}
}

func signedTicket(t *testing.T, claims map[string]any) string {
	t.Helper()
	header := encodeJSON(t, map[string]string{"alg": "HS256", "typ": "JWT"})
	payload := encodeJSON(t, claims)
	unsigned := header + "." + payload
	mac := hmac.New(sha256.New, []byte("socket-e2e-ticket-secret-with-enough-length"))
	_, _ = mac.Write([]byte(unsigned))
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func encodeJSON(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(data)
}
