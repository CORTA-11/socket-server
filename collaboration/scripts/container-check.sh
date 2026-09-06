#!/usr/bin/env bash
set -euo pipefail

container_id="$(docker run --detach --rm \
  --env COLLABORATION_PORT=18082 \
  collaboration-server:local)"

cleanup() {
  docker rm --force "$container_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT

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
