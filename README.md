# CORTA Socket Server

Separate realtime processes for team chat and collaborative Documents.

## Role

- Clients connect over WebSocket: `GET /ws?token=<socket_ticket>&team_id=<teamPublicId>`
- The ticket is issued by core-api and signed with the shared `JWT_SECRET`
- **core-api publishes chat events to Redis**; every socket-server replica
  subscribes and fans out to its local WebSocket rooms

Chat history / send / delete stay in **core-api** (REST source of truth).

```text
Browser --POST--> Core API --> Postgres
                     |
                     v
                   Redis Pub/Sub  (channel: corta:chat:events)
                     |
        +------------+------------+
        v                         v
  Socket replica A          Socket replica B
        |                         |
       WS                        WS
```

## Setup

```bash
cp .env.example .env
# Start Redis (from core-api compose):
cd ../core-api && docker compose up -d redis
```

Example `.env`:

```env
INTERNAL_API_KEY=dev-internal-key-change-me
JWT_SECRET=development-socket-ticket-secret-change-me
REDIS_URL=redis://localhost:6379/0
REDIS_CHAT_CHANNEL=corta:chat:events
PORT=8081
SOCKET_ALLOWED_ORIGINS=http://localhost:10000,http://127.0.0.1:10000,http://localhost:3000,http://127.0.0.1:3000
```

## Run

Start **Postgres + Redis + core-api**, then:

```bash
make run
```

Run unit tests:

```bash
make test
```

## Document collaboration process

The independently runnable Node 22+ Hocuspocus process owns live Document
Rooms. It does not replace the Go chat process and does not receive tenant
database credentials. It validates core-api's short-lived, Document-scoped
tickets locally before an Editing Session joins a room. It loads and stores
canonical Yjs state through core-api without receiving database credentials.

```bash
cd collaboration
npm ci
npm test
npm start
```

It listens on `COLLABORATION_HOST` (`0.0.0.0`) and
`COLLABORATION_PORT` (`8082`). Its health is independent from chat:

```bash
curl http://localhost:8082/health
# {"ok":true,"service":"collaboration-server"}

curl http://localhost:8082/metrics
# Prometheus room, Editing Session, authentication, persistence, reconnect and health metrics
```

After the core-api and infra Compose projects are running, verify the public
Envoy WebSocket route and its expected pre-ticket denial:

```bash
npm run smoke -- ws://localhost:10000/ws/docs
```

Clients use the Document's public UUID as the Hocuspocus document name and a
ticket from
`POST /api/v1/orgs/{org_id}/teams/{team_id}/documents/{document_id}/socket-ticket`.
The WebSocket URL carries the same public scope as
`/ws/docs?org_id={org_id}&team_id={team_id}`.
The collaboration process rejects tickets with an invalid signature, expired
validity, malformed or mismatched user/organization/team scope, a different
Document ID, or an Origin outside `SOCKET_ALLOWED_ORIGINS`.

Build verification is available from the repository root:

```bash
make collaboration-build
make collaboration-test
make collaboration-container-check
```

Run the bounded 25-Editor, 5 MiB Document, and 500-room operating-envelope
exercise with:

```bash
make collaboration-capacity
```

The command emits a JSON resource and behavior report. The target values are
not admission limits or latency guarantees. See
[`docs/collaboration-capacity.md`](docs/collaboration-capacity.md) for the
method, configuration, baseline result, and follow-up guidance.

Build and run with Docker:

```bash
docker build -t socket-server:local .
docker run --rm -p 8081:8081 \
  -e JWT_SECRET=development-socket-ticket-secret-change-me \
  -e REDIS_URL=redis://host.docker.internal:6379/0 \
  socket-server:local
```

Listens on `ws://localhost:8081` by default. You can run multiple instances
on different `PORT`s; all receive the same Redis events.

## Env reference

| Variable | Default | Purpose |
|----------|---------|---------|
| `INTERNAL_API_KEY` | `dev-internal-key-change-me` | Optional local debug publish guard |
| `JWT_SECRET` | (dev default) | Must match core-api socket-ticket secret |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis connection for chat and cross-replica Document Room lifecycle events |
| `REDIS_CHAT_CHANNEL` | `corta:chat:events` | Pub/Sub channel (must match core-api) |
| `PORT` | `8081` | Listen port |
| `SOCKET_ALLOWED_ORIGINS` | local Envoy and frontend origins | Browser origins allowed to connect |
| `COLLABORATION_HOST` | `0.0.0.0` | Hocuspocus listen address |
| `COLLABORATION_PORT` | `8082` | Hocuspocus listen port |
| `CORE_API_INTERNAL_URL` | `http://127.0.0.1:8080` | Base URL used to load and store canonical Document state |
| `COLLABORATION_SERVICE_SECRET` | (dev default) | Shared private credential; must match core-api and be replaced outside development |
| `COLLABORATION_AUTHENTICATION_TIMEOUT_MS` | `60000` | Absolute pre-authentication and idle timeout |
| `COLLABORATION_DEPENDENCY_TIMEOUT_MS` | `2000` | core-api readiness and persistence request timeout |
| `COLLABORATION_MAX_WEBSOCKET_MESSAGE_BYTES` | `6291456` | Maximum inbound WebSocket message, allowing the 5 MiB state target plus protocol overhead |
| `COLLABORATION_MAX_DOCUMENT_BYTES` | `6291456` | Maximum encoded canonical Yjs Document state |
| `COLLABORATION_MAX_BACKPRESSURE_BYTES` | `8388608` | Maximum bytes queued to one slow Editing Session |
| `COLLABORATION_MAX_AUTHENTICATED_QUEUE_BYTES` | `12582912` | Maximum parsed inbound bytes queued per authenticated Editing Session |
| `COLLABORATION_MAX_AUTHENTICATED_QUEUE_MESSAGES` | `64` | Maximum parsed inbound messages queued per authenticated Editing Session |
| `COLLABORATION_MAX_UNAUTHENTICATED_QUEUE_BYTES` | `262144` | Maximum pre-authentication bytes buffered per Editing Session |
| `COLLABORATION_MAX_UNAUTHENTICATED_QUEUE_MESSAGES` | `64` | Maximum pre-authentication messages buffered per Editing Session |
| `COLLABORATION_MAX_PENDING_DOCUMENTS` | `1` | Pending Document names allowed per Editing Session |
| `COLLABORATION_MAX_PERSISTENCE_RESPONSE_BYTES` | `16777216` | Maximum core-api Document-state response read into memory |
| `COLLABORATION_PERSISTENCE_DEBOUNCE_MS` | `2000` | Normal persistence batching window |
| `COLLABORATION_PERSISTENCE_MAX_DEBOUNCE_MS` | `10000` | Maximum time changes wait for a persistence attempt |

`/health` returns `503` when Redis room lifecycle or core-api readiness is
unavailable. `/metrics` uses Prometheus text format and intentionally has no
Document, Editor, ticket, email, or URL labels. Oversized frames close with
WebSocket code `1009`; an Editing Session exceeding the outbound backpressure
bound closes with `1013` without blocking other Document Rooms.

## Example: client WebSocket URL

```text
ws://localhost:8081/ws?token=<socket_ticket>&team_id=<team_public_uuid>
```

For the Document collaboration endpoint, use the scoped Hocuspocus document
name `<org_id>:<team_id>:<document_id>` and send the same organization and team
IDs as `org_id` and `team_id` query parameters. The signed Document ticket must
match all three IDs.

## Example: health check

```bash
curl http://localhost:8081/health
# {"ok":true,"bus":"redis"}
```

## Layout

```text
socket-server/
├── .env.example
├── Makefile
├── cmd/server/main.go
├── collaboration/       # Node 22+ Hocuspocus Document process
└── internal/
    ├── auth/jwt.go
    ├── bus/redis.go      # Redis subscriber → hub
    └── hub/              # in-memory rooms on this process
```
