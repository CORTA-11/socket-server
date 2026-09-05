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
