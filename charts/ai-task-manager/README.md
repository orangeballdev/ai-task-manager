# ai-task-manager Helm chart

Runs the app, the background worker and (optionally) the Slack/email
integrations as three containers in **one pod**, in its own namespace. They
share one SQLite database, so they share one `ReadWriteOnce` volume. That is
also why there is exactly one replica and rollouts use `Recreate`.

Sized for a small cluster: about 830Mi of memory and 160m of CPU requested in
total, and no CPU limits. The worker's 2Gi memory limit is the budget for the
agents and everything they build or test. Keep **Settings → concurrent tasks**
at 1 unless you raise it.

## Install

The image is private on GHCR. Create a pull secret from a token that has only
`read:packages`:

```bash
kubectl create namespace ai-task-manager
kubectl -n ai-task-manager create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=<github user> --docker-password=<token>

# Optional: secrets as env (Slack, AWS SES, analytics key, ...)
kubectl -n ai-task-manager create secret generic ai-task-manager-env \
  --from-literal=SLACK_BOT_TOKEN=... --from-literal=SLACK_APP_TOKEN=...

helm upgrade --install ai-task-manager charts/ai-task-manager \
  -n ai-task-manager \
  --set image.tag=sha-<short sha> \
  --set 'imagePullSecrets[0].name=ghcr-pull' \
  --set existingSecret=ai-task-manager-env
```

Deploy a `sha-<short sha>` tag, built by `.github/workflows/images.yml` on
each merge to main. GHCR keeps only the three newest versions.

Then `kubectl -n ai-task-manager port-forward svc/ai-task-manager 3000:3000`,
or set `ingress.enabled=true` and `ingress.host`. Sign in as the owner with
password `changeme` and change it right away.

## Notes

- **Data** lives on one PVC (`/data` for the DB and attachments, `/workspaces`
  for task workspaces, `~/.claude` for the CLI login). Workspaces grow with
  the repos you clone, so size `persistence.size` for that. The PVC is kept on
  `helm uninstall`.
- **Private repos over SSH:** create a secret with `id_ed25519` and
  `known_hosts`, then set `ssh.existingSecret`. A Git token (Settings → Git)
  needs neither.
- **No Slack or inbound email?** Set `integrations.enabled=false` to save
  about 128Mi.
- The pod gets no service account token, because agents run arbitrary
  commands in it.
