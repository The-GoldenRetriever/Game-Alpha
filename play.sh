#!/bin/sh
# ES modules need a server (file:// is blocked by CORS).
cd "$(dirname "$0")" || exit 1
PORT=${1:-8000}
( sleep 1; open "http://localhost:$PORT/" 2>/dev/null ) &
exec python3 -m http.server "$PORT"
