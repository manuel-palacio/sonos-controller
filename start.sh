#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"
URL="http://localhost:$PORT"

echo "Starting Sonos Controller on $URL ..."
node server.js &
SERVER_PID=$!

# Wait up to 10s for the server to be ready
for i in $(seq 1 20); do
  if curl -sf "$URL" > /dev/null 2>&1; then
    echo "Server ready — opening $URL"
    open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || echo "Open $URL in your browser"
    break
  fi
  sleep 0.5
done

wait $SERVER_PID
