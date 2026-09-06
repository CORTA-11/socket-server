# Repository Guidelines

These instructions apply to the entire `socket-server` repository.

## Permanent repository memory

- Treat this file as the repository's permanent memory. When work reveals
  stable, generally useful knowledge that future agents should retain, add it
  here as part of the same change.
- Record only verified, durable guidance. Do not add temporary task state,
  speculative conclusions, credentials, secrets, or personal data.

## Service boundaries

- This Go service authenticates WebSocket connections, subscribes to Redis, and
  fans events out to in-memory team rooms. It is not the source of truth for
  chat history or writes; those remain in `core-api` and Postgres.
- `cmd/server` owns process wiring. Keep ticket validation in `internal/auth`,
  Redis integration in `internal/bus`, room/client lifecycle in `internal/hub`,
  and structured logging in `internal/logging`.
- Treat every socket ticket and requested `team_id` as untrusted. Validate the
  signature, expiry, intended team, and origin before joining a room.
- Do not add replica-local state that clients depend on. Connections may land on
  any replica, and Redis is the cross-replica event path.
- Keep the WebSocket endpoint and health behavior compatible with `core-api`,
  `web-frontend`, and the Envoy configuration in `infra`.

## Coding and testing

- Use standard Go formatting and keep concurrency ownership explicit. A client
  or channel must have one clear closer; avoid blocking the hub on slow clients
  and ensure goroutines terminate on disconnect and shutdown.
- Bound message sizes, queues, deadlines, and resource use. Never log JWTs,
  internal API keys, full connection URLs containing tokens, or Redis secrets.
- Add focused tests beside the affected package. Changes to connection setup,
  authentication, origin checks, Redis delivery, or shutdown should include a
  regression test; end-to-end WebSocket coverage lives under `cmd/server`.
- Run `gofmt -w` on changed Go files and use:
  - `make test` — all tests.
  - `make build` — build `bin/socket-server`.
  - `go test -race ./...` — required for meaningful hub or concurrency changes.
- Run the narrow package test while iterating, then the full suite before handoff.
  Report any check that could not run because Redis or another service was absent.

## Configuration

- Use `.env.example` as the documented configuration contract. If a variable is
  added or renamed, update the example and `README.md` in the same change.
- `JWT_SECRET` and `REDIS_CHAT_CHANNEL` must match `core-api`; allowed origins
  must match the actual frontend/Envoy entrypoints.
- Never commit `.env`, tokens, credentials, or production connection strings.

## Agent skills

### Issue tracker

Issues are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five default canonical label names. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses the single-context layout. See `docs/agents/domain.md`.
