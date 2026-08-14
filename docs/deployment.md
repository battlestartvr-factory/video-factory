# Deployment

## Supabase

1. Create project
2. Run migration: `supabase/migrations/20260311000000_initial_schema.sql`
3. Disable public signups
4. Create admin user + `UPDATE profiles SET role = 'admin'`
5. Enable Realtime for `jobs`, `job_events` tables (Database → Replication)

## Vercel

1. Import GitHub repo `battlestartvr-factory/video-factory`
2. Framework: Next.js
3. Environment variables:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
N8N_WEBHOOK_URL=
N8N_WEBHOOK_SECRET=
APP_URL=https://your-app.vercel.app
MOCK_WORKFLOWS=false
GOOGLE_DRIVE_INTEGRATION_ENABLED=false
LOG_LEVEL=info
INGEST_PROXY_TOKEN=
B2_S3_ENDPOINT=
B2_REGION=
B2_ACCESS_KEY_ID=
B2_SECRET_ACCESS_KEY=
B2_BUCKET=battlestart-factory-temp
AGENT_LLM_BASE_URL=
AGENT_LLM_API_KEY=
AGENT_LLM_DEFAULT_MODEL=
AGENT_LLM_ALLOWED_MODELS=
WEB_SEARCH_PROVIDER=
WEB_SEARCH_API_KEY=
WEB_SEARCH_BASE_URL=
```

4. Deploy

## n8n Cloud

1. Create workflow triggered by webhook
2. Store OpenRouter/fal.ai/Google Drive credentials in n8n
3. On job.created: process source → generate content → POST callback
4. Use same `N8N_WEBHOOK_SECRET` for HMAC signing

## Google Drive (optional)

Set in Vercel when ready:
```
GOOGLE_DRIVE_INTEGRATION_ENABLED=true
GOOGLE_DRIVE_CLIENT_EMAIL=
GOOGLE_DRIVE_PRIVATE_KEY=
GOOGLE_DRIVE_SHARED_FOLDER_ID=
```

## CI

GitHub Actions runs lint, typecheck, test, build on push/PR.

## Checklist

- [ ] Supabase migration applied
- [ ] Admin user created
- [ ] Vercel env vars set
- [ ] n8n webhook configured
- [ ] MOCK_WORKFLOWS=false in production
- [ ] Visual references added to `public/references/` (optional)
- [ ] `supabase/migrations/20260814120000_universal_agent.sql` applied
- [ ] Agent LLM env vars set if Chat should call a model
- [ ] Web search env vars set if live research is required
