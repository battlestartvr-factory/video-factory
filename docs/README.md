# Documentation Map

Этот файл — карта документации для людей и coding agents.

## Canonical: читать в этом порядке

1. **`implementation-current.md`** — как завод **фактически реализован сейчас**: runtime, Game Discovery v3, research, models, Human Gates, MiniMax H3, assembly, cancellation, deploy invariants.
2. **`current-project-state.md`** — короткий operational snapshot: что уже в production, что проверено, что ещё не принято quality-тестом.
3. **`future-roadmap.md`** — отдельный документ с хотелками и идеями. Ничто в нём не считается реализованным только потому, что оно описано.
4. **`architecture.md`** — текущая system architecture и durable boundaries.
5. **`factory-runbook.md`** — operational checks/recovery/acceptance.
6. **`deployment.md`** — CI -> migration fence -> exact-SHA VPS deploy.
7. **`environment-inventory.md`** — runtime env inventory без секретов.

Если документация расходится с production code/schema, приоритет у исполняемого кода и Supabase migrations. После обнаружения drift canonical docs должны быть исправлены тем же PR или следующим немедленным docs PR.

## Current product policies

- **`stage4-economy-approval-feedback-policy.md`** — current spending/model/human-gate policy.
- Gameplay source — 16:9 desktop PC capture.
- Default gameplay still — GPT Image 2.
- Primary gameplay video — MiniMax H3 / Hailuo 03 через KIE, default 10 sec, 768P.
- Kling 3 остаётся fallback/baseline.
- Generated image/video после provider call не auto-rejected AI evaluator'ом: решения принимаются на Human Gates.

## Historical / superseded design contracts

Следующие документы сохраняются как история решений и terminology reference. Они **не описывают текущий production default**, если противоречат canonical docs выше:

- `stage4-game-discovery-pipeline-v1.md` — исходный Stage 4 design baseline;
- `stage4-5-external-intelligence-research-council-v1.md` — Stage 4.5 / `game_discovery_batch@2` Council architecture;
- `AI-content-factory_Cursor-TZ.md` в корне — первоначальное generic content-factory MVP ТЗ (Vercel/n8n/OpenRouter/fal era);
- `n8n-contract.md` — legacy generic job/n8n contract;
- `docker-deployment.md` — теперь current VPS topology + cutover history, но historical sections помечены явно.

V1/v2 workflow code остаётся зарегистрированным для совместимости/rollback/experiments, однако current chat admission запускает `game_discovery_batch@3`.

## Главная продуктовая рамка

> **content is the experiment, the game idea is the product candidate, human interest is evidence, memory is where evidence compounds**

Документы должны помогать принимать product/engineering решения вокруг этой рамки, а не превращаться в каталог устаревших AI-компонентов.
