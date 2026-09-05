package bus

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"time"

	"github.com/CORTA-11/socket-server/internal/hub"
	"github.com/redis/go-redis/v9"
)

const defaultChannel = "corta:chat:events"

// ChatEvent matches the payload published by core-api.
type ChatEvent struct {
	TeamID int64  `json:"team_id"`
	Type   string `json:"type"`
	Data   any    `json:"data"`
}

// Subscriber listens on Redis Pub/Sub and fans events into the local hub.
type Subscriber struct {
	client  *redis.Client
	channel string
	hub     *hub.Hub
}

func NewSubscriberFromEnv(h *hub.Hub) (*Subscriber, error) {
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		redisURL = "redis://localhost:6379/0"
	}
	channel := os.Getenv("REDIS_CHAT_CHANNEL")
	if channel == "" {
		channel = defaultChannel
	}

	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}

	client := redis.NewClient(opts)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, err
	}

	return &Subscriber{
		client:  client,
		channel: channel,
		hub:     h,
	}, nil
}

// Run blocks and forwards Redis messages to the local WebSocket hub.
func (s *Subscriber) Run(ctx context.Context) {
	pubsub := s.client.Subscribe(ctx, s.channel)
	defer func() {
		_ = pubsub.Close()
	}()

	slog.Info("redis subscription started", "channel", s.channel)

	ch := pubsub.Channel()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			var event ChatEvent
			if err := json.Unmarshal([]byte(msg.Payload), &event); err != nil {
				slog.Error("invalid redis event payload", "error", err, "channel", s.channel)
				continue
			}
			if event.TeamID < 1 || event.Type == "" {
				continue
			}
			s.hub.Publish(event.TeamID, hub.Event{
				Type: event.Type,
				Data: event.Data,
			})
		}
	}
}

func (s *Subscriber) Close() error {
	if s == nil || s.client == nil {
		return nil
	}
	return s.client.Close()
}
