# Техническое задание для Cursor

## ИИ-контент-завод — веб-панель MVP

> Это основной источник требований. Сначала изучи документ полностью, затем реализуй проект по этапам. Если внешний сервис ещё не настроен, сделай рабочий mock-режим и явно опиши переключение на реальную интеграцию.

## 1\. Результат

Создать внутреннее веб-приложение, в котором сотрудник:

1. Входит в систему.
2. Создаёт проект.
3. Добавляет исходник из Google Drive по ссылке или `file\_id`.
4. Создаёт задачу: сценарий, пост, изображение, короткое видео или dev diary.
5. Видит этапы и прогресс.
6. Смотрит полученные тексты, изображения и видео.
7. Принимает результат, отправляет на доработку, отменяет или повторяет задачу.
8. Видит историю действий и примерную стоимость генерации.

Это рабочая панель команды, а не публичный промосайт.

## 2\. Архитектура

Использовать один GitHub-репозиторий с Next.js-приложением.

|Компонент|Ответственность|
|-|-|
|Next.js на Vercel|Интерфейс и небольшой защищённый API-диспетчер|
|Supabase managed|PostgreSQL, авторизация, RLS, realtime|
|n8n Cloud|Долгие workflow и вызовы внешних API|
|OpenRouter|LLM; вызывается только из n8n|
|fal.ai|Изображения и видео; вызывается только из n8n|
|Google Drive|Исходники и готовые файлы на этапе MVP|
|VDS worker|Позже: FFmpeg, Remotion и тяжёлая обработка|
|GitHub|Код, pull requests, история изменений|

Поток:

\~\~\~text
Пользователь → Next.js API → Supabase: job=queued
                         → защищённый webhook n8n
n8n → OpenRouter/fal.ai/worker → Google Drive
n8n → защищённый callback Next.js → Supabase
Supabase Realtime → интерфейс
\~\~\~

### Обязательные границы

* Не размещать PostgreSQL или self-hosted Supabase в Vercel/репозитории.
* Не создавать отдельный Express/FastAPI-бэкенд для MVP.
* Не выполнять генерацию, FFmpeg или Remotion в Vercel Functions.
* Не передавать многогигабайтные видео через Vercel.
* Длинные записи команда загружает прямо в Google Drive; сайт принимает ссылку/`file\_id`.
* OpenRouter, fal.ai и Google Drive не вызываются напрямую из браузера.
* Хранилище реализовать через адаптер, чтобы позднее добавить Cloudflare R2.

## 3\. Стек

Использовать актуальные стабильные версии:

* Next.js App Router, React, TypeScript strict;
* Tailwind CSS;
* shadcn/ui или Radix UI;
* Supabase JS и официальный SSR-подход для Next.js;
* Zod;
* React Hook Form;
* Vitest;
* Playwright для smoke e2e;
* ESLint, Prettier;
* `pnpm`.

Не добавлять Redux и тяжёлые зависимости без необходимости.

## 4\. Дизайн

Тёмная премиальная панель с лёгким характером игровой студии.

Владелец добавит референсы:

* `public/references/visual-01.png` — тёмная сцена, золотое свечение;
* `public/references/visual-02.png` — яркая сцена с розовым, фиолетовым и зелёным.

Использовать их как источник палитры и настроения, не как постоянный фон. Без файлов интерфейс работает с градиентными заглушками.

Палитра:

* фон: почти чёрный/графитовый;
* поверхности: тёмно-серые;
* основной акцент: тёплый жёлтый/янтарный;
* дополнительные: розовый, фиолетовый, кислотно-зелёный;
* статусы: queued — серый, processing — фиолетовый, review — янтарный, completed — зелёный, failed — красный.

Требования:

* desktop-first, адаптация до 390 px;
* высокий контраст, минимум декоративного шума;
* скруглённые панели и мягкое свечение только у ключевых действий;
* loading/skeleton, empty, error, disabled states;
* интерфейс на русском; строки вынести в словарь для будущего EN;
* клавиатура, focus states, aria-label.

## 5\. Страницы

### Авторизация

* `/login` — email и пароль;
* `/forgot-password`;
* публичную регистрацию отключить;
* первого admin создавать через Supabase Dashboard/seed-инструкцию.

### `/dashboard`

* активные, ожидающие согласования, завершённые и ошибочные задачи;
* примерные расходы за месяц;
* последние задачи;
* кнопка «Создать задачу».

### Проекты

* `/projects` — список, поиск, фильтр;
* `/projects/new`;
* `/projects/\[projectId]` — описание, исходники, задачи, результаты, участники;
* редактирование названия, описания, языка, платформ и статуса.

### Новая задача

`/projects/\[projectId]/jobs/new` — мастер:

1. Тип: script, post, image, short\_video, dev\_diary.
2. Google Drive URL или `file\_id`.
3. Язык и целевая платформа.
4. ТЗ/комментарий.
5. Режим: economy, balanced, quality.
6. Подтверждение.

Проверять формат ссылки, но не скачивать тяжёлый файл через Vercel.

### `/jobs/\[jobId]`

* статус, прогресс 0–100%, текущий этап;
* timeline событий;
* параметры запуска;
* тексты, изображения, видео и ссылки Drive;
* токены/кредиты и оценка стоимости;
* «Принять», «На доработку», «Повторить», «Отменить»;
* комментарий к доработке;
* безопасная ошибка без секретов.

### `/assets`

* сетка результатов;
* фильтры: проект, тип, статус;
* preview изображения;
* карточка видео;
* копирование ссылки и переход в Drive.

### `/settings`

* профиль;
* статусы интеграций connected/not configured;
* секреты не показывать и не принимать через клиентские формы;
* пояснить, какие переменные задаются в Vercel/n8n.

## 6\. Роли

* `admin` — все проекты, задачи и участники;
* `member` — только проекты, где он участник.

Проверять роль сервером и RLS, не только скрытием кнопок.

## 7\. Supabase schema

Создать migrations, TypeScript-типы и seed/demo-data.

### `profiles`

`id uuid PK → auth.users`, `email`, `display\_name`, `role admin|member`, timestamps.

### `projects`

`id`, `name`, `description`, `status active|archived`, `default\_language`, `target\_platforms text\[]`, `created\_by`, timestamps.

### `project\_members`

`project\_id`, `user\_id`, `member\_role owner|editor|viewer`, composite PK, timestamps.

### `jobs`

* `id`, `project\_id`, `created\_by`;
* `type script|post|image|short\_video|dev\_diary`;
* `status draft|queued|processing|review|completed|failed|cancelled`;
* `mode economy|balanced|quality`;
* `language`, `target\_platform`, `brief`;
* `source\_provider default google\_drive`, `source\_external\_id`, `source\_url`;
* `progress smallint 0..100`, `current\_stage`;
* `n8n\_execution\_id`;
* `error\_code`, `error\_message`;
* `estimated\_cost\_usd numeric(12,4)`, `actual\_cost\_usd numeric(12,4)`;
* `started\_at`, `completed\_at`, timestamps.

### `job\_events`

`id`, `job\_id`, `event\_type`, `status`, `message`, `progress`, `metadata jsonb`, `created\_at`.

### `assets`

`id`, `project\_id`, `job\_id`, `kind source|text|image|audio|video|thumbnail|other`, `provider`, `external\_id`, `url`, `mime\_type`, `size\_bytes`, `metadata`, `created\_at`.

### `reviews`

`id`, `job\_id`, `user\_id`, `decision approved|revision\_requested`, `comment`, `created\_at`.

### `usage\_records`

`id`, `job\_id`, `provider`, `model`, `operation`, `input\_units`, `output\_units`, `cost\_usd numeric(12,6)`, `metadata`, `created\_at`.

Добавить FK и индексы минимум на:

* `jobs(status, created\_at)`;
* `jobs(project\_id, created\_at)`;
* `assets(project\_id, kind)`;
* `job\_events(job\_id, created\_at)`;
* все foreign keys.

## 8\. RLS

Включить RLS на всех пользовательских таблицах.

* admin видит всё;
* member читает только проекты из `project\_members`;
* owner/editor создаёт задачи и меняет проект;
* viewer только читает;
* events/assets/reviews/usage доступны только через проект;
* клиент не меняет системные поля job: status, progress, costs, execution id, errors;
* n8n callback обновляет системные поля только сервером с service role.

Добавить проверочный тест: пользователь проекта A не читает проект B.

## 9\. API

Единый ответ:

\~\~\~ts
type ApiSuccess<T> = { ok: true; data: T };
type ApiError = {
  ok: false;
  error: { code: string; message: string; requestId: string };
};
\~\~\~

Реализовать:

* `POST /api/jobs` — auth/role/validation, создать queued job, вызвать n8n;
* `POST /api/jobs/\[id]/cancel`;
* `POST /api/jobs/\[id]/retry` — новый запуск без потери истории;
* `POST /api/jobs/\[id]/review`;
* `POST /api/webhooks/n8n/job-update`;
* `GET /api/health` — без секретов;
* `GET /api/integrations/status` — безопасные булевы статусы.

Все мутации проверяют серверную сессию. Не доверять `user\_id`, `project\_id`, стоимости или статусу из браузера.

## 10\. Контракт Next.js → n8n

\~\~\~json
{
  "event": "job.created",
  "eventId": "uuid",
  "jobId": "uuid",
  "projectId": "uuid",
  "type": "short\_video",
  "mode": "balanced",
  "language": "ru",
  "targetPlatform": "youtube\_shorts",
  "brief": "...",
  "source": {
    "provider": "google\_drive",
    "externalId": "...",
    "url": "..."
  },
  "callbackUrl": "https://example.com/api/webhooks/n8n/job-update",
  "createdAt": "ISO-8601"
}
\~\~\~

Заголовки:

\~\~\~text
Content-Type: application/json
X-Webhook-Timestamp: unix timestamp
X-Webhook-Signature: HMAC-SHA256(rawBody, N8N\_WEBHOOK\_SECRET)
Idempotency-Key: eventId
\~\~\~

При недоступности n8n не создавать дубли. Показывать возможность повторить.

## 11\. Контракт n8n → Next.js

\~\~\~json
{
  "event": "job.updated",
  "eventId": "uuid",
  "jobId": "uuid",
  "status": "processing",
  "progress": 45,
  "stage": "Генерация раскадровки",
  "message": "Создано 6 сцен",
  "n8nExecutionId": "12345",
  "assets": \[],
  "usage": \[],
  "error": null,
  "occurredAt": "ISO-8601"
}
\~\~\~

Обязательно:

* HMAC и допустимое отклонение timestamp 5 минут;
* защита от повторного `eventId`;
* валидация перехода статуса;
* запись `job\_events`;
* идемпотентное добавление assets/usage;
* production не принимает неподписанный callback.

Переходы:

\~\~\~text
draft → queued
queued → processing | cancelled | failed
processing → review | completed | cancelled | failed
review → processing | completed | cancelled
failed → queued только через retry
completed/cancelled → конечные
\~\~\~

## 12\. Google Drive adapter

\~\~\~ts
interface StorageProvider {
  validateReference(input: string): Promise<StorageReference>;
  getMetadata(reference: StorageReference): Promise<FileMetadata>;
  createAccessUrl?(reference: StorageReference): Promise<string>;
}
\~\~\~

Реализации:

* `GoogleDriveStorageProvider`;
* `MockStorageProvider`;
* место и README для будущего `R2StorageProvider`.

В MVP достаточно нормализовать Drive URL, извлечь `file\_id`, сохранить ссылку и передать её n8n. Проверку metadata через Google API включать только с server credentials.

Не создавать публичные ссылки автоматически. Не помещать OAuth refresh token в браузер или открытую БД.

## 13\. Безопасность

* `SUPABASE\_SERVICE\_ROLE\_KEY`, `N8N\_WEBHOOK\_SECRET` и API keys — только server-side.
* Клиенту доступны только `NEXT\_PUBLIC\_SUPABASE\_URL` и `NEXT\_PUBLIC\_SUPABASE\_ANON\_KEY`.
* `.env\*` игнорировать, кроме пустого `.env.example`.
* `env.server.ts` с Zod и `server-only` imports.
* CSP и базовые security headers.
* Не использовать `dangerouslySetInnerHTML`.
* Zod для всех API payload.
* Лимиты длины полей.
* Rate limiting для создания jobs и webhook; dev fallback + production adapter.
* Ошибки без stack trace/secrets, с `requestId`.
* Не логировать токены, secrets, полные signed URLs.
* Public signup запрещён.
* Auth проверяется сервером и RLS.

Никогда не коммитить реальные ключи, даже временно.

## 14\. Mock/demo mode

При `MOCK\_WORKFLOWS=true`:

* job создаётся;
* mock поэтапно меняет статус и progress;
* создаёт demo events/assets;
* работают approve/revision/retry;
* интерфейс показывает `Demo mode`;
* production не включает mock без явной переменной.

Проект должен запускаться до подключения n8n, Drive и fal.ai.

## 15\. Структура

\~\~\~text
app/
  (auth)/login/
  (dashboard)/dashboard/
  (dashboard)/projects/
  (dashboard)/jobs/\[jobId]/
  (dashboard)/assets/
  (dashboard)/settings/
  api/jobs/
  api/webhooks/n8n/job-update/
  api/health/
components/
  ui/
  layout/
  projects/
  jobs/
  assets/
lib/
  auth/
  env/
  supabase/
  n8n/
  storage/
  validation/
  logging/
  i18n/
supabase/
  migrations/
  seed.sql
tests/
  unit/
  e2e/
public/
  references/
docs/
  architecture.md
  n8n-contract.md
  deployment.md
\~\~\~

Допустимы небольшие отклонения, но доменная логика не должна находиться в React-компонентах.

## 16\. Git/GitHub

* `main` всегда собирается.
* Feature branches: `feat/auth`, `feat/projects`, `feat/jobs`, `feat/n8n-webhook`.
* Pull request перед merge.
* Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`.
* GitHub Actions: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
* `.gitignore`: env, .next, coverage, IDE/system files, dumps, logs.
* Не хранить рабочие видео и генерации в Git.
* Референсы оптимизировать; большие binaries — вне Git или Git LFS.

## 17\. Environment

\~\~\~dotenv
NEXT\_PUBLIC\_SUPABASE\_URL=
NEXT\_PUBLIC\_SUPABASE\_ANON\_KEY=
SUPABASE\_SERVICE\_ROLE\_KEY=

N8N\_WEBHOOK\_URL=
N8N\_WEBHOOK\_SECRET=

APP\_URL=http://localhost:3000
MOCK\_WORKFLOWS=true

GOOGLE\_DRIVE\_INTEGRATION\_ENABLED=false
GOOGLE\_DRIVE\_CLIENT\_EMAIL=
GOOGLE\_DRIVE\_PRIVATE\_KEY=
GOOGLE\_DRIVE\_SHARED\_FOLDER\_ID=

LOG\_LEVEL=info
\~\~\~

Ключи OpenRouter/fal.ai не добавлять в Next.js: они хранятся в credentials n8n.

## 18\. Логи

Структурированные server logs с полями `requestId`, `userId`, `projectId`, `jobId`, `event`, `durationMs`, `result`. Не логировать секреты и чувствительные тексты целиком. Предусмотреть logger interface для будущего Sentry.

## 19\. Тесты

Минимум:

* Drive URL parser;
* HMAC verification;
* status transitions;
* API Zod schemas;
* создание job с mock n8n;
* повторный callback не создаёт дубль;
* e2e: login → project → job → progress в mock mode;
* RLS isolation двух пользователей.

Перед сдачей:

\~\~\~bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
\~\~\~

## 20\. Документация

Создать:

* `README.md` — запуск за 10–15 минут;
* `docs/architecture.md`;
* `docs/n8n-contract.md` — payload, signature, retries, curl без секретов;
* `docs/deployment.md` — Supabase + Vercel + n8n;
* migrations и инструкция первого admin;
* список mock/placeholder и ручных настроек владельца.

## 21\. Порядок реализации

### Этап 1 — foundation

Next.js, TypeScript, Tailwind, lint/format/tests, layout, design tokens, demo dashboard, env example, README.

### Этап 2 — Supabase

Migrations, enums, indexes, timestamp triggers, SSR auth, RLS, roles, seed.

### Этап 3 — product

Projects, job wizard, job page, progress/timeline, reviews, assets.

### Этап 4 — integrations

n8n HMAC client/callback, idempotency, Drive adapter, mock workflow.

### Этап 5 — quality

Tests, all UI states, responsive/accessibility, GitHub Actions, docs, production build.

После каждого этапа запускать проверки. Не переходить дальше при сломанной сборке.

## 22\. Acceptance criteria

Готово, когда:

* новый разработчик запускает проект по README;
* пользователь входит, создаёт project и job;
* mock показывает полный lifecycle;
* настроенный webhook получает job;
* подписанный callback обновляет status/events/assets/usage;
* неподписанный или старый callback отклоняется;
* RLS блокирует чужой проект;
* secrets отсутствуют в client bundle и Git history;
* UI работает на desktop и 390 px;
* lint/typecheck/tests/build проходят;
* Vercel preview открывается без runtime errors;
* docs перечисляют ручные настройки.

## 23\. Не входит в MVP

* публичная регистрация клиентов;
* платежи;
* браузерный видеоредактор;
* обработка 7–8-часового видео внутри Vercel;
* self-hosted Supabase/PostgreSQL;
* FFmpeg/Remotion на Vercel;
* OpenRouter/fal.ai из браузера;
* полная реализация R2;
* multi-tenant organizations;
* мобильное приложение.

## 24\. Отчёт Cursor

После работы сообщить:

1. Что реализовано.
2. Какие migrations/files добавлены.
3. Какие проверки запущены и результаты.
4. Что работает в mock.
5. Какие URL/secrets должен добавить владелец.
6. Что осталось.
7. URL Vercel preview, если настроен.

Не называть функцию готовой, если есть только UI. Такие места помечать mock/placeholder.

