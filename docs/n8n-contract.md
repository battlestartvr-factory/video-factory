# n8n Contract

## Next.js → n8n

**Endpoint:** `POST {N8N_WEBHOOK_URL}`

**Headers:**
```
Content-Type: application/json
X-Webhook-Timestamp: {unix}
X-Webhook-Signature: HMAC-SHA256(rawBody, N8N_WEBHOOK_SECRET)
Idempotency-Key: {eventId}
```

**Body:**
```json
{
  "event": "job.created",
  "eventId": "uuid",
  "jobId": "uuid",
  "projectId": "uuid",
  "type": "short_video",
  "mode": "balanced",
  "language": "ru",
  "targetPlatform": "youtube_shorts",
  "brief": "...",
  "source": {
    "provider": "google_drive",
    "externalId": "...",
    "url": "..."
  },
  "callbackUrl": "https://your-app.vercel.app/api/webhooks/n8n/job-update",
  "createdAt": "2026-03-11T12:00:00.000Z"
}
```

## n8n → Next.js

**Endpoint:** `POST /api/webhooks/n8n/job-update`

**Headers:** same HMAC scheme

**Body:**
```json
{
  "event": "job.updated",
  "eventId": "uuid",
  "jobId": "uuid",
  "status": "processing",
  "progress": 45,
  "stage": "Генерация раскадровки",
  "message": "Создано 6 сцен",
  "n8nExecutionId": "12345",
  "assets": [],
  "usage": [],
  "error": null,
  "occurredAt": "2026-03-11T12:05:00.000Z"
}
```

## Status transitions

```
draft → queued
queued → processing | cancelled | failed
processing → review | completed | cancelled | failed
review → processing | completed | cancelled
failed → queued (retry only)
completed/cancelled → terminal
```

## Idempotency

Повторный `eventId` возвращает `{ ok: true, data: { duplicate: true } }` без дублей.

## Test curl (без секретов)

```bash
# Health check
curl https://your-app.vercel.app/api/health

# Unsigned callback rejected in production
curl -X POST https://your-app.vercel.app/api/webhooks/n8n/job-update \
  -H "Content-Type: application/json" \
  -d '{"event":"job.updated","eventId":"00000000-0000-4000-8000-000000000001","jobId":"...","status":"processing","occurredAt":"2026-03-11T12:00:00.000Z"}'
```

## Retries

При недоступности n8n задача помечается failed с кодом `N8N_DISPATCH_FAILED`. Пользователь использует «Повторить».
