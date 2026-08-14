# Deployment

## Supabase

1. Create project
2. Run migrations in order:
   - `supabase/migrations/20260311000000_initial_schema.sql`
   - `supabase/migrations/20260814000000_ai_workspace_schema.sql`
   - `supabase/migrations/20260814120000_universal_agent.sql`
   - `supabase/migrations/20260814140000_knowledge_drive_fts.sql`
3. Disable public signups
4. Create admin user + `UPDATE profiles SET role = 'admin'`
5. Enable Realtime for `jobs`, `job_events` tables (Database → Replication)

## Vercel

1. Import GitHub repo `battlestartvr-factory/video-factory`
2. Framework: Next.js
3. Environment variables (canonical set — see also `docs/environment-inventory.md`):

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
KIE_API_KEY=
KIE_API_BASE_URL=https://api.kie.ai
APP_URL=https://your-app.vercel.app
MOCK_WORKFLOWS=false
LOG_LEVEL=info

# Knowledge Base originals (optional)
GOOGLE_DRIVE_INTEGRATION_ENABLED=false
GOOGLE_DRIVE_AUTH_MODE=service_account
GOOGLE_DRIVE_SHARED_FOLDER_ID=
GOOGLE_DRIVE_CLIENT_EMAIL=
GOOGLE_DRIVE_PRIVATE_KEY=
# oauth_user mode alternative:
# GOOGLE_DRIVE_CLIENT_ID=
# GOOGLE_DRIVE_CLIENT_SECRET=
# GOOGLE_DRIVE_REFRESH_TOKEN=

# Web research (optional)
WEB_SEARCH_PROVIDER=
WEB_SEARCH_API_KEY=
WEB_SEARCH_BASE_URL=

# n8n / factory (legacy but still used by jobs)
N8N_WEBHOOK_URL=
N8N_WEBHOOK_SECRET=
N8N_FACTORY_BASE_URL=
FACTORY_WEBHOOK_SECRET=

# Asset ingest
INGEST_PROXY_TOKEN=
B2_S3_ENDPOINT=
B2_REGION=
B2_ACCESS_KEY_ID=
B2_SECRET_ACCESS_KEY=
B2_BUCKET=battlestart-factory-temp
```

4. Deploy

## n8n Cloud

1. Create workflow triggered by webhook
2. Store OpenRouter/fal.ai/Google Drive credentials in n8n
3. On job.created: process source → generate content → POST callback
4. Use same `N8N_WEBHOOK_SECRET` for HMAC signing

## Google Drive (Knowledge Base)

When `GOOGLE_DRIVE_INTEGRATION_ENABLED=true`:

1. Create/configure shared folder and set `GOOGLE_DRIVE_SHARED_FOLDER_ID`
2. Choose auth mode via `GOOGLE_DRIVE_AUTH_MODE`:
   - `service_account`: set `GOOGLE_DRIVE_CLIENT_EMAIL` + `GOOGLE_DRIVE_PRIVATE_KEY`
   - `oauth_user`: set `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_REFRESH_TOKEN`
3. Share the root folder with the service account or OAuth user
4. App stores originals under `Knowledge/Global/` and `Knowledge/Projects/<project-id>/`

Upload flow: browser receives resumable upload URL from `/api/knowledge/upload`, uploads directly to Google, then calls finalize.

## CI

GitHub Actions runs lint, typecheck, test, build on push/PR.

## Checklist

- [ ] Supabase migrations applied (including `20260814140000_knowledge_drive_fts.sql`)
- [ ] Admin user created
- [ ] Vercel env vars set (`KIE_API_KEY`, Supabase, optional Drive)
- [ ] n8n webhook configured (if jobs/factory used)
- [ ] `MOCK_WORKFLOWS=false` in production
- [ ] Google Drive configured for Knowledge Base PDF/DOCX storage (optional)
