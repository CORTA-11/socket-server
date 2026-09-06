-include .env

CACHE_DIR := $(CURDIR)/.cache
GOCACHE := $(CACHE_DIR)/go-build
GOFLAGS ?= -buildvcs=false
GO_PACKAGES := ./cmd/... ./internal/...

export GOCACHE GOFLAGS
export CORE_API_URL
export INTERNAL_API_KEY
export JWT_SECRET
export REDIS_URL
export REDIS_CHAT_CHANNEL
export PORT
export COLLABORATION_HOST
export COLLABORATION_PORT

.PHONY: check fmt-check mod-check vet run build test test-race image \
	collaboration-run collaboration-build collaboration-test collaboration-container-check

check: fmt-check mod-check vet build

fmt-check:
	@files="$$(gofmt -l $$(find cmd internal -type f -name '*.go'))"; \
	if [ -n "$$files" ]; then echo "Go files need formatting:"; echo "$$files"; exit 1; fi

mod-check:
	@tmp="$$(mktemp -d)"; trap 'rm -rf "$$tmp"' EXIT; \
	cp go.mod go.sum "$$tmp"; \
	cp -R cmd internal "$$tmp"; \
	(cd "$$tmp" && GOWORK=off go mod tidy); \
	diff -u go.mod "$$tmp/go.mod"; \
	diff -u go.sum "$$tmp/go.sum"

vet:
	go vet $(GO_PACKAGES)

run:
	go run ./cmd/server

build:
	go build -o bin/socket-server ./cmd/server

test:
	go test $(GO_PACKAGES)

test-race:
	go test -race $(GO_PACKAGES)

image:
	docker build -t socket-server:local .

collaboration-run:
	npm --prefix collaboration start

collaboration-build:
	npm --prefix collaboration run build

collaboration-test:
	npm --prefix collaboration test

collaboration-container-check:
	docker build -t collaboration-server:local collaboration
	bash collaboration/scripts/container-check.sh
