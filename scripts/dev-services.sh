#!/usr/bin/env bash
# Start dev dependencies in podman: app Postgres + self-hosted Firecrawl.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.local ] && set -a && . ./.env.local && set +a

if ! podman info >/dev/null 2>&1; then
  echo "▸ starting podman machine"
  podman machine start
fi

echo "▸ postgres (compose.yaml)"
podman compose up -d db

FC_URL="${FIRECRAWL_API_URL:-http://localhost:3002}"
if curl -sf -m 3 "$FC_URL" >/dev/null 2>&1 || curl -s -m 3 -o /dev/null -w '%{http_code}' "$FC_URL" | grep -qE '^[2-4]'; then
  echo "▸ firecrawl already up at $FC_URL"
else
  FC_DIR="${FIRECRAWL_LOCAL_DIR:-../firecrawl-local}"
  existing=$(podman ps -aq --filter label=com.docker.compose.project=firecrawl)
  if [ -n "$existing" ]; then
    echo "▸ starting existing firecrawl containers"
    podman start $existing >/dev/null
  elif [ -d "$FC_DIR" ]; then
    echo "▸ starting firecrawl from $FC_DIR (prebuilt images)"
    (cd "$FC_DIR" && podman compose -f compose.local.yaml up -d --no-build)
  else
    echo "! Firecrawl not running and FIRECRAWL_LOCAL_DIR ($FC_DIR) not found — web enrichment will be skipped" >&2
  fi
fi

echo "▸ waiting for postgres"
for _ in $(seq 1 30); do
  podman compose exec -T db pg_isready -U caselaw >/dev/null 2>&1 && break
  sleep 1
done
echo "▸ waiting for firecrawl"
for _ in $(seq 1 60); do
  curl -s -m 2 -o /dev/null "$FC_URL" && break
  sleep 1
done
echo "✓ services ready"
