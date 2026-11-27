# syntax=docker/dockerfile:1
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client bash curl ca-certificates ripgrep python3 python3-pip \
    make g++ gosu \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (optional — used for PR operations)
RUN ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') && \
    GH_VER=$(curl -sf https://api.github.com/repos/cli/cli/releases/latest | grep '"tag_name"' | sed 's/.*"v\([^"]*\)".*/\1/') && \
    curl -sL "https://github.com/cli/cli/releases/download/v${GH_VER}/gh_${GH_VER}_linux_${ARCH}.tar.gz" | tar xz -C /tmp && \
    mv "/tmp/gh_${GH_VER}_linux_${ARCH}/bin/gh" /usr/local/bin/gh || true

# Install subscription-backed coding agent CLIs globally so they are available
# to the app and worker containers.
#
# claude-code is version-pinned (rather than left to float to whatever is
# latest at build time) for two reasons: it keeps the model list in
# src/lib/models.ts working — newer model IDs (e.g. claude-opus-5-5) require
# a CLI new enough to know about them, and an unpinned `npm install -g` line
# is also a stable string that Docker happily reuses from its build cache
# forever, silently keeping a stale/incompatible CLI even across rebuilds.
# When bumping ANTHROPIC_MODELS to a new model family, bump this version too
# (and the RUN line changes, which also busts the Docker cache).
RUN npm install -g @anthropic-ai/claude-code@2.1.281 @openai/codex

# uid pinned (it was already 1001: node:20-slim's own `node` user is 1000) so the
# build cache mounts below can be owned by it.
RUN useradd -m -u 1001 -s /bin/bash appuser && \
    mkdir -p /data /workspaces /app && \
    chown appuser:appuser /data /workspaces /app

USER appuser
WORKDIR /app

COPY --chown=appuser:appuser package*.json ./
COPY --chown=appuser:appuser prisma ./prisma
# npm's download cache survives between builds, so a dependency change only
# fetches what's new instead of every package.
RUN --mount=type=cache,target=/home/appuser/.npm,uid=1001,gid=1001 npm ci --include=dev

COPY --chown=appuser:appuser . .
# Next.js's build cache survives between builds too (it isn't part of the image),
# so unchanged pages aren't recompiled from scratch. .next is created first as
# appuser: otherwise the mount creates it owned by root and the build can't write to it.
RUN mkdir -p .next
#
# Shown as the version in the app's help (?) modal; images.yml passes the image's
# sha- tag and the full commit. Declared here, after the dependency layers, so a
# new value only rebuilds from this point. Empty for a local `--build`.
ARG APP_VERSION=
ARG GIT_COMMIT=
#
# Prerendering some pages (e.g. /docs/api) reads Settings, so the build gets a
# throwaway database. It isn't kept: the containers use /data. `db push` creates
# the current schema in one step, and /dev/shm keeps it in memory. Replaying
# every migration on disk took about a minute per build.
RUN --mount=type=cache,target=/app/.next/cache,uid=1001,gid=1001 \
    export DATABASE_URL=file:/dev/shm/build.db && \
    npx prisma generate && npx prisma db push && npm run build && rm -f /dev/shm/build.db* && \
    chmod +x entrypoint.sh && \
    cp -r public .next/standalone/public && \
    cp -r .next/static .next/standalone/.next/static

EXPOSE 3000

# Switch back to root so the entrypoint can fix volume ownership before dropping to appuser
USER root
ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", ".next/standalone/server.js"]
