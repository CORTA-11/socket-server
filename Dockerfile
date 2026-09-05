FROM golang:1.26-alpine AS builder

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -o /out/socket-server ./cmd/server

FROM alpine:3.22

RUN adduser -D -H -u 10001 appuser
USER appuser

COPY --from=builder /out/socket-server /usr/local/bin/socket-server

EXPOSE 8081

ENTRYPOINT ["/usr/local/bin/socket-server"]
