#!/bin/sh
# AI Task Manager installer: runs the app locally with Docker.
#
#   curl -fsSL __SITE_URL__/install.sh | sh
#
# Creates ./ai-task-manager (override with AI_TASK_MANAGER_DIR), downloads the
# docker-compose.yml from __SITE_URL__ into it, pulls the prebuilt image and starts
# the app on http://localhost:3000 (override with AI_TASK_MANAGER_PORT). If the image
# can't be pulled, it clones __REPO_URL__ and builds the image from source instead.
#
# Run it again to update: it re-downloads the compose file and pulls the latest image.
# Your data lives in Docker volumes and is kept.
#
# This file is a template: scripts/site/build.tsx fills in the URLs.

set -eu

SITE_URL="__SITE_URL__"
REPO_URL="__REPO_URL__"
DIR="${AI_TASK_MANAGER_DIR:-ai-task-manager}"
PORT="${AI_TASK_MANAGER_PORT:-3000}"
# One project name for both install paths, so the prebuilt and built-from-source
# installs share the same volumes (database, workspaces, CLI logins).
export COMPOSE_PROJECT_NAME=ai-task-manager
export AI_TASK_MANAGER_PORT="$PORT"

say() { printf '\033[1;38;5;209m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Everything runs inside main, so a download cut off half way can't run half a script.
main() {
  command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Get it from https://docs.docker.com/get-docker/ and run this again."
  docker info >/dev/null 2>&1 || fail "Docker is installed but not running (or you can't reach it). Start Docker and run this again."
  docker compose version >/dev/null 2>&1 || fail "The Docker Compose plugin is missing. See https://docs.docker.com/compose/install/"
  command -v curl >/dev/null 2>&1 || fail "curl is required."

  mkdir -p "$DIR"
  cd "$DIR"
  say "Installing into $(pwd)"

  say "Downloading docker-compose.yml"
  curl -fsSL "$SITE_URL/docker-compose.yml" -o docker-compose.yml.new || fail "Couldn't download $SITE_URL/docker-compose.yml"
  mv docker-compose.yml.new docker-compose.yml

  say "Pulling the prebuilt image"
  if docker compose pull --quiet 2>/dev/null; then
    say "Starting AI Task Manager"
    docker compose up -d --remove-orphans
  else
    say "No prebuilt image available, building from source instead (takes a few minutes)"
    command -v git >/dev/null 2>&1 || fail "git is required to build from source."
    if [ -d source/.git ]; then
      git -C source pull --ff-only --quiet
    else
      git clone --depth 1 --quiet "$REPO_URL" source
    fi
    (cd source && docker compose up -d --build --remove-orphans)
  fi

  say "Waiting for the app to come up"
  i=0
  until curl -fsS -o /dev/null "http://localhost:$PORT/api/settings/worker-health" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -ge 90 ] && fail "The app didn't answer on port $PORT. Check: cd $(pwd) && docker compose logs app"
    sleep 2
  done

  printf '\n'
  say "AI Task Manager is running at http://localhost:$PORT"
  printf '\n  Next: Settings -> AI providers -> add a connection and sign in.\n'
  printf '  Guide: %s/docs/\n' "$SITE_URL"
  printf '\n  Logs:     cd %s && docker compose logs -f worker\n' "$(pwd)"
  printf '  Stop:     cd %s && docker compose down\n' "$(pwd)"
  printf '  Update:   run this installer again\n\n'
}

main "$@"
