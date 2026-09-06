-include .env

export CORE_API_URL
export INTERNAL_API_KEY
export JWT_SECRET
export REDIS_URL
export REDIS_CHAT_CHANNEL
export PORT
export COLLABORATION_HOST
export COLLABORATION_PORT

.PHONY: run build test collaboration-run collaboration-build collaboration-test collaboration-container-check

run:
	go run ./cmd/server

build:
	go build -o bin/socket-server ./cmd/server

test:
	go test ./...

collaboration-run:
	npm --prefix collaboration start

collaboration-build:
	npm --prefix collaboration run build

collaboration-test:
	npm --prefix collaboration test

collaboration-container-check:
	docker build -t collaboration-server:local collaboration
	bash collaboration/scripts/container-check.sh
