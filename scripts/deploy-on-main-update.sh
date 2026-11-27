#!/usr/bin/env bash
# Keeps a self-hosted Docker Compose install on the newest published image.
# Run from a dedicated clone of the repo, e.g. every few minutes from a systemd
# timer or cron. It fast-forwards the clone to origin/main (so compose file
# changes arrive), pulls the image docker-compose.yml names, and recreates only
# the containers whose image or config changed, so an idle run touches nothing.
# A new image appears a few minutes after a push to main, once images.yml has
# built it.
set -euo pipefail

cd "$(dirname "$0")/.."

git fetch --quiet origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "$(date -Iseconds) main updated: $(git rev-parse --short HEAD) -> $(git rev-parse --short origin/main)"
  git merge --ff-only --quiet origin/main
fi

docker compose pull --quiet
docker compose up -d --remove-orphans
