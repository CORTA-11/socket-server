# CORTA Socket Server

Separate realtime service for team chat (and later collaborative docs).

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
| `REDIS_URL` | `redis://localhost:6379/0` | Redis connection |
| `REDIS_CHAT_CHANNEL` | `corta:chat:events` | Pub/Sub channel (must match core-api) |
| `PORT` | `8081` | Listen port |
| `SOCKET_ALLOWED_ORIGINS` | local Envoy and frontend origins | Browser origins allowed to connect |

## Example: client WebSocket URL

```text
ws://localhost:8081/ws?token=<socket_ticket>&team_id=<team_public_uuid>
```

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
└── internal/
    ├── auth/jwt.go
    ├── bus/redis.go      # Redis subscriber → hub
    └── hub/              # in-memory rooms on this process
```
