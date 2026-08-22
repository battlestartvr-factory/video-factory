# AI Co-op Game Discovery Factory

Внутренний AI-завод Battle Start VR для **поиска, evidence-прототипирования и накопления сигналов по PC/Steam co-op игровым идеям**.

Главная рамка: **content is the experiment, the game idea is the product candidate, human interest is evidence, memory is where evidence compounds**.

## Current production

Текущий default — **Game Discovery v3 (`game_discovery_batch@3`)**.

```text
естественный запрос в чате
 -> bounded KIE grounded research + Safe Fetch
 -> verified Research Pack
 -> GPT-5.6 Terra -> ровно 3 концепта
 -> Human Concept Gate
 -> gameplay moment + evidence shot
 -> Gameplay Reference Set
 -> GPT Image 2 gameplay still
 -> Human Image Gate
 -> MiniMax H3 / Hailuo 03, 10s, 768P, I2V через KIE
 -> Human Video Gate
 -> FFmpeg assembly + lineage/archive
```

**Kling 3 не удалён:** он остаётся enabled fallback/baseline. Creative LLM не выбирает video provider самостоятельно — current factory policy deterministic.

V1/V2 workflow code также сохранён для совместимости/rollback/experiments, но не является current chat default.

## Human Gates

Три durable gates обязательны:

1. concept approve/revise/reject;
2. generated reference image approve/revise/reject;
3. generated gameplay video approve/revise/reject.

Generated media после provider call не auto-rejected AI evaluator'ом. Planning/authenticity gates могут остановить spend **до** provider call; решение по уже сгенерированному media остаётся за человеком.

## Research v3

Production research использует shared verified source pool, а не старую default-схему из пяти независимых Scout searches.

- KIE `gemini-3-6-flash` + Google Search grounding;
- direct URLs + Safe Fetch;
- canonical/content dedupe;
- required competitor/mechanics/player_voice/gameplay_visual coverage;
- minimum 4 verified sources;
- maximum 10 accepted sources;
- absolute maximum 6 KIE search/provider calls;
- targeted recovery only for missing coverage.

## Production runtime

Primary production — **Ubuntu VPS + Docker Compose + Caddy**:

`https://battlestart-factory.duckdns.org`

Services:

- Next.js app;
- core durable worker, concurrency 1;
- research durable worker, concurrency 5;
- Caddy HTTPS;
- Supabase managed;
- KIE provider layer;
- Google Drive durable archive.

Release path:

`PR -> CI -> main -> DB schema fence -> Deploy Production -> exact SHA on VPS`.

A legacy Vercel status check is not production authority.

## Documentation

Start here:

1. [Current implementation — canonical](docs/implementation-current.md)
2. [Current project state / handoff](docs/current-project-state.md)
3. [Future roadmap / хотелки](docs/future-roadmap.md)
4. [Architecture](docs/architecture.md)
5. [Factory runbook](docs/factory-runbook.md)
6. [Deployment](docs/deployment.md)
7. [Environment inventory](docs/environment-inventory.md)

Historical design contracts remain in the repository, but each should be treated as history when it conflicts with the canonical current implementation.

## Local start

```bash
git clone https://github.com/battlestartvr-factory/video-factory.git
cd video-factory
pnpm install
cp .env.example .env.local
pnpm dev
```

Provider/Drive features require server-side credentials. Never commit production secrets.

## Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | Dev server |
| `pnpm build` | Production build |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript |
| `pnpm test` | Vitest |
| `pnpm test:e2e` | Playwright smoke |

## Main directories

- `app/` — Next.js UI + API;
- `components/` — UI;
- `lib/agent/` — Universal Agent + turn/tool routing;
- `lib/orchestrator/` — durable orchestration, provider lifecycle, recovery;
- `lib/research-intelligence/` — research acquisition/evidence/v2-v3 intelligence;
- `lib/game-discovery/` — gameplay semantics, Human Gate helpers, references, prompts;
- `worker/` — durable workflow execution;
- `supabase/migrations/` — authoritative DB evolution;
- `docs/` — current architecture/runbooks + clearly separated history/future.

Ключевой engineering invariant: **DB state authoritative; queue delivery is a wake-up signal, not workflow truth.**
