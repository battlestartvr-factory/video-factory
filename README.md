# AI Co-op Game Discovery Factory

Внутренний AI-завод Battle Start VR для **автономного поиска, прототипирования и накопления evidence по PC/Steam co-op игровым идеям**.

Главная продуктовая рамка: **content is the experiment, the game idea is the product candidate, human interest is evidence, memory is where evidence compounds**. Генерация изображений и видео остаётся важным слоем, но не является конечной целью системы.

## Текущий статус

- Stage 1–3: durable production foundation — закрыты.
- **Stage 4 — Game Discovery Pipeline: technical DONE.** Канонический путь умеет пройти от discovery objective до разных co-op concepts, human concept gate, gameplay moment/shot planning, gameplay references, image/video evidence, human media gates, assembly и полной lineage.
- Gameplay Reference Library: 10 игр / 76 архивированных image references. Closeout-indexing оставшихся references запущен через durable `gameplay_reference_index@1`; актуальное состояние и SQL-проверки — в `docs/current-project-state.md`.
- Следующая продуктовая цель: **Stage 5 + Stage 6 — Gameplay Quality Evaluation + Learning/Memory Loop**, чтобы следующий discovery batch становился измеримо лучше предыдущего.
- Платный Tilt Salvage authenticity regression остаётся осознанно отложенным acceptance-тестом; он не блокирует техническое закрытие Stage 4.

## Production

Primary production runtime — **Ubuntu VPS + Docker Compose + Caddy**, публичный host: `https://battlestart-factory.duckdns.org`.

GitHub Actions `CI` проверяет lint/typecheck/tests/build. После успешного CI на `main` workflow `Deploy Production` делает SSH deploy на VPS. Vercel больше не является источником истины для production; возможный legacy Vercel status check не определяет здоровье VPS deployment.

Подробнее: `docs/deployment.md` и `docs/current-project-state.md`.

## Быстрый старт

```bash
git clone https://github.com/battlestartvr-factory/video-factory.git
cd video-factory
pnpm install
cp .env.example .env.local
pnpm dev
```

Для локальной работы нужны Supabase credentials; provider/Drive functionality требует соответствующих server-side secrets. Не копируйте production secrets в Git.

### Cursor / agents

В репозитории есть agent skills и Supabase MCP configuration. Перед изменением durable workflow новый агент должен сначала прочитать:

1. `docs/current-project-state.md`
2. `docs/architecture.md`
3. `docs/factory-runbook.md`
4. `docs/stage4-game-discovery-pipeline-v1.md` — как design/contract baseline, не как текущий статус
5. `docs/stage4-economy-approval-feedback-policy.md`

Ключевой принцип: DB state является authoritative; queue delivery — wake-up signal, а не источник workflow state.

## Скрипты

| Команда | Назначение |
|---|---|
| `pnpm dev` | Dev server |
| `pnpm build` | Production build |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript |
| `pnpm test` | Vitest unit tests |
| `pnpm test:e2e` | Playwright smoke |

## Основные каталоги

- `app/` — Next.js UI + API routes
- `components/` — UI
- `lib/orchestrator/` — durable orchestration/recovery/provider lifecycle
- `lib/game-discovery/` — Stage 4 domain, human gates, reference library, authenticity logic
- `worker/` — durable worker + workflow handlers
- `supabase/migrations/` — authoritative DB evolution
- `docs/` — architecture, runbooks, deployment and current-stage handoff

## Документация

- [Current project state / agent handoff](docs/current-project-state.md)
- [Architecture](docs/architecture.md)
- [Factory runbook](docs/factory-runbook.md)
- [Deployment](docs/deployment.md)
- [Stage 4 pipeline baseline](docs/stage4-game-discovery-pipeline-v1.md)
- [Stage 4 economy / approval / feedback policy](docs/stage4-economy-approval-feedback-policy.md)
