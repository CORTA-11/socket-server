-include .env

export CORE_API_URL
export INTERNAL_API_KEY
export JWT_SECRET
export REDIS_URL
export REDIS_CHAT_CHANNEL
export PORT

.PHONY: run build test

run:
	go run ./cmd/server

build:
	go build -o bin/socket-server ./cmd/server

test:
	go test ./...
