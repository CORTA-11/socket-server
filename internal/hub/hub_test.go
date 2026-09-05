package hub

import (
	"encoding/json"
	"testing"
	"time"
)

func TestHubPublishFansOutOnlyToMatchingTeam(t *testing.T) {
	h := New()
	go h.Run()
	teamClient := &Client{hub: h, teamID: 10, send: make(chan []byte, 1)}
	otherClient := &Client{hub: h, teamID: 20, send: make(chan []byte, 1)}
	h.register <- teamClient
	h.register <- otherClient

	h.Publish(10, Event{Type: "message.created", Data: map[string]any{"id": "message-1"}})

	payload := receive(t, teamClient.send)
	var event Event
	if err := json.Unmarshal(payload, &event); err != nil {
		t.Fatalf("unmarshal event: %v", err)
	}
	if event.Type != "message.created" {
		t.Fatalf("event type = %q", event.Type)
	}
	select {
	case payload := <-otherClient.send:
		t.Fatalf("other team received %s", string(payload))
	case <-time.After(50 * time.Millisecond):
	}
}

func TestAllowsOriginIncludesEnvoyDevelopmentEntrypoint(t *testing.T) {
	t.Setenv("SOCKET_ALLOWED_ORIGINS", "")
	for _, origin := range []string{"", "http://localhost:10000", "http://127.0.0.1:10000"} {
		if !AllowsOrigin(origin) {
			t.Fatalf("origin %q was rejected", origin)
		}
	}
	if AllowsOrigin("http://example.test") {
		t.Fatal("unexpectedly accepted unknown origin")
	}
}

func receive(t *testing.T, ch <-chan []byte) []byte {
	t.Helper()
	select {
	case payload := <-ch:
		return payload
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for event")
		return nil
	}
}
