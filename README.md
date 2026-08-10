# CORTA Socket Server

Separate realtime service for team chat (and later collaborative docs).

## Role

- Clients connect over WebSocket: `GET /ws?token=<jwt>&team_id=<teamPublicId>`
- Membership is verified via core-api `GET /internal/team-access`
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
CORE_API_URL=http://localhost:8080
INTERNAL_API_KEY=dev-internal-key-change-me
JWT_SECRET=your-super-secret-key-change-in-production
REDIS_URL=redis://localhost:6379/0
REDIS_CHAT_CHANNEL=corta:chat:events
PORT=8081
```

## Run

Start **Postgres + Redis + core-api**, then:

```bash
make run
```

Listens on `ws://localhost:8081` by default. You can run multiple instances
on different `PORT`s; all receive the same Redis events.

## Env reference

| Variable | Default | Purpose |
|----------|---------|---------|
| `CORE_API_URL` | `http://localhost:8080` | Membership checks |
| `INTERNAL_API_KEY` | `dev-internal-key-change-me` | Shared with core-api |
| `JWT_SECRET` | (dev default) | Must match core-api |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis connection |
| `REDIS_CHAT_CHANNEL` | `corta:chat:events` | Pub/Sub channel (must match core-api) |
| `PORT` | `8081` | Listen port |

## Example: client WebSocket URL

```text
ws://localhost:8081/ws?token=<access_jwt>&team_id=<team_public_uuid>
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
    ├── coreapi/client.go
    └── hub/              # in-memory rooms on this process
```
