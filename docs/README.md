# Documentation Map

Этот файл — навигация для следующих coding agents. Если документы расходятся по текущему состоянию, приоритет у более верхнего уровня списка ниже.

## Canonical current state

1. **`current-project-state.md`** — первый документ для нового агента: продуктовая цель, текущий stage, production facts, known-good runs, закрытые/отложенные acceptance items и следующий milestone.
2. **`architecture.md`** — актуальная VPS/Supabase/worker архитектура и durable invariants.
3. **`factory-runbook.md`** — операционные проверки, recovery, human gates, Gameplay Reference indexing и cost discipline.
4. **`deployment.md`** — актуальный production release path: GitHub CI -> Deploy Production -> VPS exact SHA.

## Stage 4 contract / design baseline

- **`stage4-game-discovery-pipeline-v1.md`** — design/contract baseline Stage 4. Полезен для терминологии и исходных требований, но status/deployment детали сверять с `current-project-state.md`.
- **`stage4-economy-approval-feedback-policy.md`** — политика расходов, human approval и feedback loops.
- Остальные `stage4-*` документы — специализированные design/implementation notes. Они не отменяют текущие production facts из canonical current-state документов.

## Deployment / migration history

- `docker-deployment.md` содержит подробности VPS/Docker cutover, включая исторические формулировки перехода с Vercel.
- `environment-inventory.md` и env examples — источник названий переменных/секретов.
- `n8n-contract.md`, ранние provider/seed документы и похожие материалы — legacy/history, если только текущий код явно не ссылается на них.

## Agent rule

Перед изменением durable workflow сначала прочитать canonical current state + relevant stage contract, затем проверить фактический `main`, Supabase schema/migrations и production lineage. Не восстанавливать архитектуру по одному старому design doc.

Главная продуктовая рамка проекта: **content is the experiment, the game idea is the product candidate, human interest is evidence, memory is where evidence compounds**.
