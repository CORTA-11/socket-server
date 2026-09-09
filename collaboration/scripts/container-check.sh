#!/usr/bin/env bash
set -euo pipefail

network_name="collaboration-container-check-$$"
redis_id=""
core_api_id=""
container_id=""

cleanup() {
  if [[ -n "$container_id" ]]; then
    docker rm --force "$container_id" >/dev/null 2>&1 || true
  fi
  if [[ -n "$redis_id" ]]; then
    docker rm --force "$redis_id" >/dev/null 2>&1 || true
  fi
  if [[ -n "$core_api_id" ]]; then
    docker rm --force "$core_api_id" >/dev/null 2>&1 || true
  fi
  docker network rm "$network_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$network_name" >/dev/null
redis_id="$(docker run --detach \
  --network "$network_name" \
  --network-alias redis \
  redis:8.8.1)"
core_api_id="$(docker run --detach \
  --network "$network_name" \
  --network-alias core-api \
  --entrypoint node \
  collaboration-server:local \
  -e 'require("node:http").createServer((request,response)=>{response.writeHead(request.url==="/health/ready"?204:404);response.end()}).listen(8080,"0.0.0.0")')"
container_id="$(docker run --detach \
  --env COLLABORATION_PORT=18082 \
  --env CORE_API_INTERNAL_URL=http://core-api:8080 \
  --env REDIS_URL=redis://redis:6379/0 \
  --network "$network_name" \
  collaboration-server:local)"

for _ in $(seq 1 15); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$container_id")"
  if [[ "$status" == "healthy" ]]; then
    exit 0
  fi
  sleep 1
done

docker logs "$container_id"
echo "collaboration container did not become healthy" >&2
exit 1
