{{/* Common name + label helpers */}}
{{- define "skilly.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "skilly.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "skilly.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "skilly.labels" -}}
app.kubernetes.io/name: {{ include "skilly.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "skilly.secretName" -}}
{{- if .Values.secrets.existingSecret -}}{{ .Values.secrets.existingSecret }}{{- else -}}{{ include "skilly.fullname" . }}-secrets{{- end -}}
{{- end -}}

{{/* Postgres host the app connects to (bundled service or external). */}}
{{- define "skilly.pgHost" -}}
{{- if .Values.postgres.enabled -}}{{ include "skilly.fullname" . }}-postgres{{- else -}}{{ required "postgres.external.host is required when postgres.enabled=false" .Values.postgres.external.host }}{{- end -}}
{{- end -}}

{{- define "skilly.pgPort" -}}
{{- if .Values.postgres.enabled -}}5432{{- else -}}{{ .Values.postgres.external.port | default 5432 }}{{- end -}}
{{- end -}}

{{/* S3 endpoint / access key / bucket (bundled MinIO or external). */}}
{{- define "skilly.s3Endpoint" -}}
{{- if .Values.minio.enabled -}}http://{{ include "skilly.fullname" . }}-minio:9000{{- else -}}{{ required "minio.external.endpoint is required when minio.enabled=false" .Values.minio.external.endpoint }}{{- end -}}
{{- end -}}

{{- define "skilly.s3AccessKey" -}}
{{- if .Values.minio.enabled -}}{{ .Values.minio.rootUser }}{{- else -}}{{ .Values.minio.external.accessKey }}{{- end -}}
{{- end -}}

{{- define "skilly.s3Bucket" -}}
{{- if .Values.minio.enabled -}}{{ .Values.minio.bucket }}{{- else -}}{{ .Values.minio.external.bucket | default "skilly-artifacts" }}{{- end -}}
{{- end -}}

{{- define "skilly.webImage" -}}
{{ .Values.image.web.repository }}:{{ .Values.image.web.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "skilly.workerImage" -}}
{{ .Values.image.worker.repository }}:{{ .Values.image.worker.tag | default .Chart.AppVersion }}
{{- end -}}
