{{- define "atm.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "atm.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "atm.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "atm.image" -}}
{{ .Values.image.repository }}:{{ required "image.tag is required, e.g. --set image.tag=sha-77e2cbe" .Values.image.tag }}
{{- end -}}

{{- define "atm.envSecretName" -}}
{{- if .Values.existingSecret -}}{{ .Values.existingSecret }}{{- else if .Values.secretEnv -}}{{ include "atm.fullname" . }}-env{{- end -}}
{{- end -}}

{{/* Environment shared by every container. */}}
{{- define "atm.env" -}}
- name: DATABASE_URL
  value: file:/data/dev.db
- name: WORKSPACES_PATH
  value: /workspaces
- name: ATTACHMENTS_PATH
  value: /data/attachments
- name: NODE_ENV
  value: production
- name: HOME
  value: /home/appuser
{{- if not .Values.integrations.enabled }}
# Tells the UI the Slack bot can't run here (src/lib/deployment.ts).
- name: INTEGRATIONS_SERVICE_ENABLED
  value: "false"
{{- end }}
{{- range $k, $v := .Values.env }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- end -}}

{{- define "atm.envFrom" -}}
{{- with include "atm.envSecretName" . -}}
envFrom:
  - secretRef:
      name: {{ . }}
{{- end }}
{{- end -}}

{{/* data -> /data, workspaces -> /workspaces, claude -> ~/.claude */}}
{{- define "atm.mounts" -}}
- name: data
  mountPath: /data
  subPath: data
- name: data
  mountPath: /workspaces
  subPath: workspaces
- name: data
  mountPath: /home/appuser/.claude
  subPath: claude
{{- end -}}

{{/*
Replaces the image's entrypoint (which needs root and gosu) for the long-running
containers: restores ~/.claude.json from the Claude CLI's backups when the
container's filesystem lost it, as the entrypoint does, then execs the args.
*/}}
{{- define "atm.command" -}}
["sh", "-c", "f=/home/appuser/.claude.json; b=/home/appuser/.claude/backups; if [ ! -f \"$f\" ] && [ -d \"$b\" ]; then l=$(ls -t \"$b\"/.claude.json.backup.* 2>/dev/null | head -1); [ -n \"$l\" ] && cp \"$l\" \"$f\"; fi; exec \"$@\"", "sh"]
{{- end -}}
