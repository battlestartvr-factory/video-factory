# Архитектура

## Обзор

```
Пользователь → Next.js (Vercel) → Supabase (PostgreSQL + Auth + Realtime)
                              ↘ n8n Cloud (webhook)
n8n → OpenRouter / fal.ai / Google Drive
n8n → POST /api/webhooks/n8n/job-update → Supabase (service role)
Supabase Realtime → UI (прогресс задач)
```

## Компоненты

| Слой | Технология | Ответственность |
|------|------------|-----------------|
| Frontend | Next.js App Router, React, Tailwind, shadcn-style UI | Панель команды |
| API | Next.js Route Handlers | Auth, validation, n8n dispatch, webhook callback |
| Database | Supabase PostgreSQL | Projects, jobs, assets, RLS |
| Auth | Supabase Auth (SSR) | Email/password, без public signup |
| Workflows | n8n Cloud | LLM, генерация медиа, Drive |
| Storage adapter | `lib/storage/` | Google Drive (MVP), mock, R2 (future) |

## Границы MVP

- Нет self-hosted PostgreSQL
- Нет Express/FastAPI backend
- Нет FFmpeg/Remotion в Vercel
- OpenRouter/fal.ai только через n8n
- Большие файлы — ссылки Google Drive, не upload через Vercel

## Роли

- **admin** — полный доступ
- **member** — только проекты из `project_members`
- RLS + server-side checks

## Mock mode

`MOCK_WORKFLOWS=true` запускает in-process симуляцию прогресса задачи без n8n.

## Realtime

Страница задачи подписывается на `postgres_changes` для `jobs` и `job_events`.
