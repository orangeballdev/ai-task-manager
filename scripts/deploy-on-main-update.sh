#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

git fetch origin main

local_sha=$(git rev-parse main)
remote_sha=$(git rev-parse origin/main)

if [ "$local_sha" = "$remote_sha" ]; then
  exit 0
fi

echo "$(date -Iseconds) main updated: $local_sha -> $remote_sha"

git merge --ff-only origin/main

docker compose up --build -d
