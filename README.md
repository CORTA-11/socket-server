# Synodus realtime services

Two independent processes:

- **Chat**: Go WebSocket server on port 8081. Validates core-api tickets and fans
  Redis events out to team rooms. Chat writes and history remain in core-api.
- **Documents**: Node.js/Hocuspocus server on port 8082. Synchronizes Yjs rooms
  and loads/stores document state through core-api's private API.

For the complete local stack, use the
[infra installer](https://github.com/CORTA-11/infra#local-setup).

## Source development

Requires Go matching `go.mod`, Node.js 22+, Make, Redis, and a running core-api.
From this repository:

```bash
cp .env.example .env
npm --prefix collaboration ci
make collaboration-build
```

Run each service in its own terminal:

```bash
make run
make collaboration-run
```

`JWT_SECRET` and `REDIS_CHAT_CHANNEL` must match core-api.
`COLLABORATION_SERVICE_SECRET` must also match core-api and stay private.
Set `CORE_API_INTERNAL_URL`, `REDIS_URL`, and `SOCKET_ALLOWED_ORIGINS` for your
setup. See [`.env.example`](.env.example) for all settings and resource limits.

## Connect and verify

Browsers connect through Envoy at `localhost:10000`:

- Chat: `/ws?token=<socket_ticket>&team_id=<team_uuid>`.
- Documents: `/ws/docs?org_id=<org_uuid>&team_id=<team_uuid>`, using
  `<org_uuid>:<team_uuid>:<document_uuid>` as the Hocuspocus document name and a
  document ticket as the connection token.

Core-api issues both ticket types. Private document calls recheck membership
and content access; collaboration has no database credentials.

```bash
curl -fsS http://localhost:8081/health
curl -fsS http://localhost:8082/health
npm --prefix collaboration run smoke -- ws://localhost:10000/ws/docs
```

The smoke check expects an upgrade followed by rejection of a missing ticket.
Document health requires core-api and Redis. `/metrics` on port 8082 exposes
collaboration metrics.

## Checks and operating limits

```bash
make check
make test
make test-race
make collaboration-test
make collaboration-container-check
make collaboration-capacity
```

Run one document collaboration replica: room ownership and Yjs updates are
process-local. Redis coordinates document deletion, not room synchronization.
Canonical document state belongs in tenant PostgreSQL backups.
See [capacity guidance](docs/collaboration-capacity.md) for the operating
exercise and [architecture decisions](docs/adr/) for design details.
