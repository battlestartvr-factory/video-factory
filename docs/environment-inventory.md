# Environment inventory

Generated from actual code references in the repository.

| Variable | Purpose | Required? | Client/server | Secret? | Status |
|---|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | **Yes** (runtime) | client + server | no | REQUIRED NOW |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key for browser/auth | **Yes** (runtime) | client + server | no (public) | REQUIRED NOW |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role for server writes | **Yes** (server features) | server | **yes** | REQUIRED NOW |
| `SUPABASE_SECRET_KEY` | Alternate server secret (`sb_secret_*`) | optional fallback | server | **yes** | LEGACY BUT STILL USED |
| `KIE_API_KEY` | Canonical KIE provider API key | **Yes** (Chat/agent) | server | **yes** | REQUIRED NOW |
| `KIE_API_BASE_URL` | KIE root URL | optional (default `https://api.kie.ai`) | server | no | OPTIONAL |
| `APP_URL` | Public app URL for callbacks/links | recommended | server | no | REQUIRED NOW |
| `GOOGLE_DRIVE_INTEGRATION_ENABLED` | Enable Drive-backed knowledge uploads | optional | server | no | OPTIONAL |
| `GOOGLE_DRIVE_AUTH_MODE` | `service_account` or `oauth_user` | when Drive enabled | server | no | OPTIONAL |
| `GOOGLE_DRIVE_SHARED_FOLDER_ID` | Drive root folder for knowledge originals | when Drive enabled | server | no | OPTIONAL |
| `GOOGLE_DRIVE_CLIENT_EMAIL` | Service account email | service_account mode | server | no | OPTIONAL |
| `GOOGLE_DRIVE_PRIVATE_KEY` | Service account private key | service_account mode | server | **yes** | OPTIONAL |
| `GOOGLE_DRIVE_CLIENT_ID` | OAuth client id | oauth_user mode | server | no | OPTIONAL |
| `GOOGLE_DRIVE_CLIENT_SECRET` | OAuth client secret | oauth_user mode | server | **yes** | OPTIONAL |
| `GOOGLE_DRIVE_REFRESH_TOKEN` | Pre-issued OAuth refresh token | oauth_user mode | server | **yes** | OPTIONAL |
| `N8N_WEBHOOK_URL` | Legacy jobs webhook | when jobs enabled | server | no | LEGACY BUT STILL USED |
| `N8N_WEBHOOK_SECRET` | HMAC secret for legacy jobs webhook | when jobs enabled | server | **yes** | LEGACY BUT STILL USED |
| `N8N_FACTORY_BASE_URL` | Factory n8n base URL | when factory enabled | server | no | LEGACY BUT STILL USED |
| `FACTORY_WEBHOOK_SECRET` | Factory webhook HMAC secret | when factory enabled | server | **yes** | LEGACY BUT STILL USED |
| `INGEST_PROXY_TOKEN` | Internal asset-ingest auth token | when ingest proxy used | server | **yes** | LEGACY BUT STILL USED |
| `B2_S3_ENDPOINT` | Backblaze B2 S3 endpoint | asset ingest | server | no | REQUIRED NOW (ingest) |
| `B2_REGION` | B2 region | asset ingest | server | no | REQUIRED NOW (ingest) |
| `B2_ACCESS_KEY_ID` | B2 access key | asset ingest | server | **yes** | REQUIRED NOW (ingest) |
| `B2_SECRET_ACCESS_KEY` | B2 secret key | asset ingest | server | **yes** | REQUIRED NOW (ingest) |
| `B2_BUCKET` | B2 temp bucket name | asset ingest | server | no | REQUIRED NOW (ingest) |
| `WEB_SEARCH_PROVIDER` | Web research provider (`tavily`/`brave`/`generic`/`none`) | optional | server | no | OPTIONAL |
| `WEB_SEARCH_API_KEY` | Web research API key | when web search enabled | server | **yes** | OPTIONAL |
| `WEB_SEARCH_BASE_URL` | Generic web search base URL | `generic` provider | server | no | OPTIONAL |
| `LOG_LEVEL` | Server log level | optional | server | no | OPTIONAL |
| `MOCK_WORKFLOWS` | Local mock for n8n workflows | dev only | server | no | OPTIONAL |
| `AGENT_LLM_API_KEY` | Deprecated alias of `KIE_API_KEY` | fallback only | server | **yes** | LEGACY BUT STILL USED |
| `AGENT_LLM_BASE_URL` | Deprecated KIE base URL override | fallback only | server | no | LEGACY BUT STILL USED |
| `AGENT_LLM_DEFAULT_MODEL` | Override default LLM when set | optional | server | no | LEGACY BUT STILL USED |
| `AGENT_LLM_ALLOWED_MODELS` | Legacy allow-list (registry is canonical) | unused at runtime | server | no | SAFE TO REMOVE AFTER REDEPLOY |
| `CI` | CI flag for Playwright/tests | CI only | build | no | UNUSED (CI infra) |
| `npm_package_version` | Package version in health endpoint | automatic | server | no | UNUSED (runtime meta) |

## Category summary

### REQUIRED NOW
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`)
- `KIE_API_KEY`
- `APP_URL`
- B2 set when asset ingest is used: `B2_S3_ENDPOINT`, `B2_REGION`, `B2_ACCESS_KEY_ID`, `B2_SECRET_ACCESS_KEY`, `B2_BUCKET`

### OPTIONAL
- `KIE_API_BASE_URL`
- Google Drive knowledge storage set (see `.env.example`)
- `WEB_SEARCH_*`
- `LOG_LEVEL`, `MOCK_WORKFLOWS`

### LEGACY BUT STILL USED
- `AGENT_LLM_API_KEY`, `AGENT_LLM_BASE_URL`, `AGENT_LLM_DEFAULT_MODEL`
- `SUPABASE_SECRET_KEY`
- n8n: `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`, `N8N_FACTORY_BASE_URL`, `FACTORY_WEBHOOK_SECRET`
- `INGEST_PROXY_TOKEN`

### SAFE TO REMOVE AFTER REDEPLOY
- `AGENT_LLM_ALLOWED_MODELS` (registry is source of truth; no runtime enforcement)

### UNUSED
- None confirmed beyond CI/meta variables above.
