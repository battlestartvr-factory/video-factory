# ИИ-контент-завод

Внутренняя веб-панель для генерации контента (сценарии, посты, изображения, видео) команды Battle Start VR.

## Быстрый старт (10–15 минут)

### 1. Клонирование и зависимости

```bash
git clone https://github.com/battlestartvr-factory/video-factory.git
cd video-factory
pnpm install
cp .env.example .env.local
```

### 2. Supabase

1. Создайте проект на [supabase.com](https://supabase.com)
2. В SQL Editor выполните миграции из `supabase/migrations/` по порядку
3. Отключите public signup: Authentication → Providers → Email → Disable sign ups
4. Создайте первого пользователя в Dashboard → Authentication → Users
5. Назначьте admin:

```sql
UPDATE profiles SET role = 'admin' WHERE email = 'your@email.com';
```

6. Скопируйте URL, anon key и service role key в `.env.local`

### 2.1. Cursor: Agent Skills + Supabase MCP

В репозитории уже установлены skills (`npx skills add supabase/agent-skills`) и конфиг MCP:

- `.agents/skills/supabase` и `.agents/skills/supabase-postgres-best-practices`
- `.cursor/mcp.json` → `https://mcp.supabase.com/mcp`

Чтобы агент реально ходил в ваш проект Supabase:

1. Cursor → **Settings → Tools & MCP** → сервер `supabase` → **Authenticate** (OAuth в браузере).
2. Выберите организацию и проект.
3. При необходимости перезапустите Cursor / агента.

Для приложения по-прежнему нужны `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` в `.env.local`.

### 3. Запуск

```bash
pnpm dev
```

Откройте http://localhost:3000 — войдите созданным пользователем.

При `MOCK_WORKFLOWS=true` (по умолчанию) задачи проходят полный demo-lifecycle без n8n.

### 4. n8n (опционально)

1. Создайте webhook workflow в n8n Cloud
2. Задайте `N8N_WEBHOOK_URL` и `N8N_WEBHOOK_SECRET` в Vercel
3. Установите `MOCK_WORKFLOWS=false`

Контракт: см. `docs/n8n-contract.md`

## Скрипты

| Команда | Описание |
|---------|----------|
| `pnpm dev` | Dev-сервер |
| `pnpm build` | Production build |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript |
| `pnpm test` | Vitest unit tests |
| `pnpm test:e2e` | Playwright smoke |

## Структура

- `app/` — Next.js App Router (страницы + API)
- `components/` — UI-компоненты
- `lib/` — доменная логика (auth, n8n, storage, validation)
- `supabase/migrations/` — SQL-схема и RLS
- `docs/` — архитектура, deployment, n8n-контракт

## Mock / placeholder

| Компонент | Статус |
|-----------|--------|
| n8n dispatch | Mock при `MOCK_WORKFLOWS=true` |
| Google Drive metadata | Mock без credentials |
| R2 storage | Placeholder в `lib/storage/` |
| Visual references | `public/references/` — добавьте PNG вручную |

## Переменные окружения

См. `.env.example`. Секреты OpenRouter/fal.ai хранятся только в n8n.

## Первый admin

Public signup отключён. Admin создаётся через Supabase Dashboard + SQL `UPDATE profiles SET role = 'admin'`.

## Документация

- [Архитектура](docs/architecture.md)
- [n8n контракт](docs/n8n-contract.md)
- [Deployment](docs/deployment.md)
