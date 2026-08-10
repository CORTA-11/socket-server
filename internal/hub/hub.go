package hub

import (
	"encoding/json"
	"sync"
)

type Event struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

type Hub struct {
	mu         sync.RWMutex
	rooms      map[int64]map[*Client]struct{}
	register   chan *Client
	unregister chan *Client
	broadcast  chan roomMessage
}

type roomMessage struct {
	teamID  int64
	payload []byte
}

func New() *Hub {
	return &Hub{
		rooms:      make(map[int64]map[*Client]struct{}),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		broadcast:  make(chan roomMessage, 64),
	}
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			if _, ok := h.rooms[client.teamID]; !ok {
				h.rooms[client.teamID] = make(map[*Client]struct{})
			}
			h.rooms[client.teamID][client] = struct{}{}
			h.mu.Unlock()

		case client := <-h.unregister:
			h.mu.Lock()
			if clients, ok := h.rooms[client.teamID]; ok {
				if _, exists := clients[client]; exists {
					delete(clients, client)
					close(client.send)
					if len(clients) == 0 {
						delete(h.rooms, client.teamID)
					}
				}
			}
			h.mu.Unlock()

		case msg := <-h.broadcast:
			h.mu.RLock()
			for client := range h.rooms[msg.teamID] {
				select {
				case client.send <- msg.payload:
				default:
					go func(c *Client) {
						h.unregister <- c
					}(client)
				}
			}
			h.mu.RUnlock()
		}
	}
}

func (h *Hub) Publish(teamID int64, event Event) {
	payload, err := json.Marshal(event)
	if err != nil {
		return
	}
	h.broadcast <- roomMessage{teamID: teamID, payload: payload}
}
