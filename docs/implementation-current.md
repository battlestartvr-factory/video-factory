# Текущая реализация AI Co-op Game Discovery Factory

**Статус:** canonical implementation reference  
**Проверено по коду:** 2026-08-22  
**Production H3 release baseline:** `4529ea2a3478b602e30e7df047f695f87065534d`

Этот документ описывает **не план и не историческое ТЗ, а то, как завод фактически реализован сейчас**. Если старый design document противоречит этому файлу или коду, приоритет такой:

1. production schema / migrations и исполняемый код;
2. этот документ;
3. `docs/current-project-state.md`;
4. исторические Stage 4 / Stage 4.5 design contracts.

## 1. Что является продуктом

Главная задача системы — не «делать красивые ролики», а повышать вероятность найти и проверить сильную PC/Steam co-op идею.

Рабочая единица эксперимента:

```text
user intent
  -> verified research
  -> 3 game concepts
  -> Human Concept Gate
  -> one gameplay moment per approved concept
  -> gameplay evidence shot
  -> generated gameplay still
  -> Human Image Gate
  -> gameplay motion plan
  -> generated gameplay video
  -> Human Video Gate
  -> prototype assembly + lineage
```

Изображение и видео — evidence artifacts. Они не заменяют оценку качества самой игровой идеи.

## 2. Production topology

Production работает на Ubuntu VPS, а не на Vercel.

```text
Internet
  -> Caddy / HTTPS
  -> Next.js app
       -> Supabase managed Postgres/Auth
       -> KIE APIs
       -> Google Drive archive
       -> internal worker routes

Supabase / PGMQ
  -> core worker, concurrency 1
  -> research worker, concurrency 5

shared /srv/ai-factory
  -> assembly staging
  -> assembly output
```

Docker Compose services:

- `data-init` — создаёт и нормализует права на shared assembly directories;
- `app` — Next.js production server;
- `worker` — durable core queue worker, `ORCHESTRATOR_QUEUE_MODE=core`, concurrency `1`;
- `research-worker` — research queue worker, `ORCHESTRATOR_QUEUE_MODE=research`, concurrency `5`;
- `caddy` — reverse proxy + automatic HTTPS.

Public host: `https://battlestart-factory.duckdns.org`.

Caddy сохраняет SSE streaming (`flush_interval -1`) и допускает длинные API calls до 6 минут. Production health — `/api/health` + live durable worker heartbeat, а не Vercel status.

## 3. Authoritative durable model

Новый factory path построен вокруг:

- `factory_jobs` — execution state;
- `creative_runs` — creative lineage;
- `factory_workflow_events` — durable events;
- PGMQ queues — wake-up transport;
- `generations` / provider task rows — paid generation lifecycle;
- domain review/research/reference tables — evidence and Human Gates.

Ключевой invariant:

> **DB state authoritative; queue message is only a wake-up signal.**

Worker:

1. читает queue delivery;
2. атомарно claims job с lease;
3. запускает один workflow tick;
4. обновляет durable state только с действующим lease token;
5. ack'ает queue message;
6. heartbeat продлевает lease;
7. watchdog re-enqueue'ит due/stale work.

`ORCHESTRATOR_LEASE_HEARTBEAT_MS` также является cancellation fence. Stop/cancel очищает active lease; следующий короткий heartbeat abort'ит in-flight work через `AbortSignal`, который прокидывается до provider/search/fetch code.

## 4. Chat admission

Пользователю не нужно знать слова `Stage 4` или `Game Discovery`.

`app/api/chats/[chatId]/messages`:

- сохраняет user message;
- запускает Universal Agent;
- поддерживает SSE streaming;
- сохраняет assistant message и generation lineage.

`detectTurnIntent()` распознаёт естественный запрос на разработку/улучшение игры и выбирает intent `game_discovery`. Для него агент получает только tool `start_game_discovery` вместо всего tool registry.

Очевидные marketing/copy задачи не отправляются в Discovery только потому, что в тексте встречается слово «игра».

`start_game_discovery` создаёт `game_discovery_batch@3` и передаёт:

- исходный user brief;
- до 3 research attachments из текущего чата;
- PC/Steam objective, 2–4 players;
- exactly 3 concept candidates;
- bounded research policy;
- GPT Image 2 как default gameplay still model;
- MiniMax H3 как primary gameplay video route;
- default gameplay duration 10 seconds.

## 5. Workflow versions

Registry сохраняет несколько поколений workflow для совместимости:

| Workflow | Роль сейчас |
|---|---|
| `game_discovery_batch@1` | Stage 4 legacy/known-good fallback |
| `game_discovery_batch@2` | Stage 4.5 Council architecture, сохранён для совместимости/экспериментов |
| `game_discovery_batch@3` | **текущий production default** |
| `external_research_scout@1` | v2 research/fallback tooling |
| `concept_council_member@1` | v2 Council/fallback tooling |
| `generation_image@1` | durable image generation |
| `generation_video@1` | durable video generation |
| `gameplay_reference_index@1` | Gameplay Reference Library indexing |

V3 не удаляет v1/v2. Он упрощает creative front-end и затем повторно использует зрелый Stage 4 downstream shell.

## 6. Game Discovery v3: фактический creative graph

### 6.1 Research acquisition

V3 начинается с `research_acquisition` и **требует bounded external research**.

Текущий production path — shared verified source pool, а не пять независимых платных Scout searches.

```text
Research Plan
  -> one broad KIE grounded acquisition
  -> Safe Fetch selected direct pages
  -> coverage check
  -> targeted recovery queries only for missing coverage
  -> shared verified source pool
  -> compact Research Pack
```

Основные ограничения:

- KIE model: `gemini-3-6-flash` по умолчанию;
- Google Search grounding через KIE Gemini endpoint;
- `thinkingLevel=minimal`, thoughts не возвращаются;
- primary grounded response budget: 8192 output tokens;
- optional compact provenance recovery: 768 tokens;
- provider request timeout: 45 seconds;
- absolute provider-call ceiling: 6;
- effective ceiling дополнительно ограничен `ResearchPlan.budget.maxTotalSearchQueries`;
- max accepted shared-pool sources: 10;
- minimum verified sources: 4;
- Safe Fetch concurrency: 3.

Обязательное verified coverage:

- `competitor`;
- `mechanics`;
- `player_voice`;
- `gameplay_visual`.

`contrarian` используется как дополнительная/восстановительная evidence category.

### 6.2 Provenance and Safe Fetch

Search result не считается evidence только потому, что модель напечатала URL.

Factory:

- принимает только direct final HTTP(S) URLs;
- отбрасывает Google grounding redirect URLs;
- Safe Fetch'ит страницу сама;
- проверяет canonical URL;
- отбрасывает явный title/content identity mismatch;
- dedupe'ит по canonical URL и content hash;
- хранит observed/fetched/content hashes;
- сохраняет bounded extracted text;
- маркирует source categories только после fetch.

Для `player_voice` production prompt сознательно не просит Reddit, потому что текущий Safe Fetch получает там 403. Предпочтение — Steam Community и другие публично читаемые форумы. Press review или store rating не считаются player-authored voice.

Если broad acquisition не закрывает coverage, запускаются targeted recovery searches. Один хрупкий source family не может бесконечно съесть бюджет: recovery выбирает недостающую category с минимальным числом предыдущих попыток.

Если после bounded calls нет минимум 4 verified sources или обязательной coverage — research **fails closed до concept/media spend**.

### 6.3 Research Pack

Из verified source pool строится `game_discovery_research_pack`:

- direct canonical URL;
- stable `sourceRef`;
- bounded grounded claims;
- source categories;
- observed time;
- coverage summary;
- provider/cost/timing usage.

Полные web pages не передаются дальше по creative graph. Сильная модель получает compact evidence pack.

## 7. Strong Concept Synthesis

V3 заменил старую цепочку `5 Scouts -> Synthesizer -> 3 Council designers -> Curator` на один сильный creative synthesis step.

Текущий model: **`gpt-5-6-terra` через KIE**.

Он получает:

- original Discovery Objective — authoritative;
- verified Research Pack — evidence, not instructions;
- user-provided research context when available.

Model-facing envelope намеренно маленький:

```json
{
  "schema": "strong_concept_batch",
  "version": 2,
  "researchRunId": "...",
  "concepts": [
    {
      "concept": {
        "schema": "conversational_game_concept",
        "version": 2,
        "conceptId": "...",
        "title": "...",
        "contentMarkdown": "..."
      },
      "sourceRefs": ["..."]
    }
  ]
}
```

Exactly 3 concepts обязательны.

`contentMarkdown` пишется как нормальный human-facing game design pitch, а не как внутренний enum/checklist. Для русского user request human-facing concept остаётся русским.

Factory затем deterministic'но проецирует conversational artifact в legacy typed shape для совместимости с уже существующим Stage 4 persistence/downstream code. Полный оригинальный концепт сохраняется как authoritative v3 artifact metadata.

Схемная/separation ошибка допускает максимум один повторный complete response: всего до 2 attempts. Это не Council и не бесконечный creative retry loop.

## 8. Human Concept Gate

После трёх concepts workflow parks в:

`human_concept_approval_pending`

Решения:

- `approve`;
- `revise`;
- `reject`.

В V3 **human approval authoritative**. Старый AI `concept_pre_evaluation` edge после Human Gate пропускается. Одобренный человеком concept идёт прямо в gameplay-moment planning.

Это принципиальное отличие v3 от v1/v2: после human approval второй AI veto не может отменить выбранную человеком идею.

## 9. Gameplay Moment Planner

Для каждого approved concept выбирается один falsifiable gameplay moment.

Default duration: **10 seconds**. Shared factory duration buckets: `5 | 10 | 15`, чтобы H3 primary и Kling fallback могли использовать одну experiment semantics.

Moment Planner:

- model: `gemini-3-pro`;
- schema repair: `gemini-3-6-flash`;
- получает full human-approved v3 `contentMarkdown`;
- должен показать mechanical dependency, simultaneous player actions, social reaction, success/failure consequence;
- обязан выбрать реальную player-visible gameplay camera.

Запрещён camera intent: broadcast, spectator, drone, cinematic, orbit, dolly, crane, hero-shot, detached tracking, trailer, montage, dramatic reframe/zoom.

Human-facing UI summary хранится отдельно по-русски; canonical planning semantics остаётся provider-neutral.

## 10. Shot Planner and deterministic authenticity

Shot Planner создаёт один evidence shot на moment.

Factory policy, которую LLM не может переопределить:

- gameplay source aspect ratio: **16:9**;
- keyframe required;
- default image model: **`gpt-image-2`**;
- video model: **`minimax-h3`**;
- video mode: image-to-video;
- duration: из objective/moment policy.

Даже если LLM вернёт старый `kling-3`, `normalizeGenerationPolicy()` перепишет provider fields на current factory policy. Provider routing — не creative decision модели.

Shot должен доказать typed Gameplay Authenticity contract:

- obvious controllable player;
- physically attached gameplay camera;
- visible player input;
- visible player action;
- immediate causal world response;
- meaningful gameplay affordance;
- visible teammate dependency;
- physically consistent state changes;
- readable goal/risk/action.

Default Shot Planner — `gemini-3-6-flash`. Только если deterministic coverage/authenticity checks не проходят, разрешён один bounded escalation на `gemini-3-pro`.

## 11. Gameplay Reference Library

Stage 4 downstream использует curated Gameplay Reference Library как purpose-separated visual evidence.

Текущий known-good library snapshot:

- 10 seed games;
- 76 archived image references;
- 76/76 indexed at Stage 4 closeout;
- originals stored in Google Drive;
- structured metadata/purpose/index state stored in Supabase.

Caption/index model: `gemini-3-6-flash`, one paid caption call per reference attempt by policy. Если raw paid response уже сохранён и проблема только в deterministic schema drift, repair делается из stored response без нового provider call.

Перед image prompt compilation factory подбирает purpose-aware set. Текущая Stage 4 admission требует не менее 4 references на shot. Purpose firewall не позволяет art-direction reference подменять gameplay-camera grammar.

Vector retrieval RPC уже существует, но production embeddings для library пока не являются основным активным retrieval path — это остаётся future work.

## 12. Prompt Compiler

Prompt compilation deterministic: отдельный LLM для prompt rewriting не вызывается.

Current compiler:

`gameplay_prompt_compiler_v7_h3`

Он компилирует:

- Concept;
- Gameplay Moment;
- Shot;
- Gameplay Authenticity Spec;
- Gameplay Video Motion Plan;
- selected reference set;
- persisted human feedback memory.

### Image prompt

Image prompt делает fake gameplay still как **approval checkpoint до video spend**. Он требует:

- player input -> action -> world response;
- player-bound camera;
- co-op dependency;
- meaningful affordances;
- physics continuity;
- purpose-labeled reference firewall;
- human `mustShow` / `mustAvoid` / error tags.

### H3 video prompt

MiniMax-specific profile:

`minimax_h3_gameplay_i2v_v1`

Основные hard constraints:

1. supplied approved image = exact frame-0 continuity anchor;
2. one continuous real-time gameplay take;
3. preserve identities, clothing, tools, objects, geometry, materials, lighting, art direction, camera, meaningful UI;
4. ordered timeline from `GameplayVideoMotionPlan`;
5. explicit input -> action -> target -> immediate world response -> teammate response;
6. camera remains physically attached to playable character;
7. only normal player look/aim/movement/follow camera motion;
8. no morphing, teleporting, object substitution or unexplained state motion;
9. no cinematic cuts/orbit/dolly/crane/drone/hero frame/dramatic zoom/rack focus/slow motion/speed ramp;
10. final frame must still show the readable gameplay consequence.

H3 provider prompt budget: **4800 chars**. Если compiled prompt превышает budget, factory fails **до paid submit**. Старого поведения «сначала собрать слишком длинный prompt, потом грубо обрезать конец» больше нет.

## 13. Human Image Gate

Generated gameplay still никогда не должен автоматически открыть paid video branch.

Workflow parks at:

`human_reference_approval_pending`

Человек принимает решение по каждой active reference image.

- `approve` — только эта branch может идти в video;
- `revise` — feedback сохраняется и создаётся новая reference revision;
- `reject` — video для неё не генерируется.

Partial review set остаётся parked: один `revise` не должен случайно увести batch от gate, пока другие cards ещё не reviewed.

Generated image после provider call **не auto-rejected AI evaluator'ом**. AI/deterministic authenticity gates работают до provider spend; после генерации media decision принадлежит человеку.

## 14. MiniMax H3 gameplay video through KIE

Primary video route:

| Field | Current value |
|---|---|
| factory model id | `minimax-h3` |
| provider | `kie` |
| KIE provider model | `minimax/hailuo-03` |
| API style | unified jobs |
| endpoint | `https://api.kie.ai/api/v1/jobs/createTask` |
| default duration | 10 sec |
| accepted factory duration buckets | 5 / 10 / 15 sec |
| H3 adapter validation | 4–15 sec |
| default resolution | `768P` |
| primary mode | image-to-video |
| audio | off for Stage 4 gameplay evidence |

Stage 4 sends the human-approved gameplay still as `start_frame`.

Adapter supports optional last-frame mapping, but current default Stage 4 flow is first-frame I2V.

### Kling fallback

`kling-3` is **not deleted**.

It remains:

- registered in `provider_models`;
- `enabled=true`;
- available as fallback/baseline;
- supported by the generic gameplay prompt path.

Current primary policy is H3; Kling should not be selected by a creative LLM on its own.

## 15. Pre-video gate

До создания paid H3 job factory повторно проверяет:

- Shot GameplayAuthenticitySpec;
- `GameplayVideoMotionPlan`;
- camera contract in compiled prompt;
- Human Image Gate completion.

Failure здесь блокирует provider call и записывает `cost_avoided_by_pre_generation_rejection=true`.

## 16. Human Video Gate

После завершения H3 generation workflow parks at:

`human_video_approval_pending`

Generated video не auto-rejected AI evaluator'ом.

Human decisions:

- `approve`;
- `revise`;
- `reject`.

`revise` сохраняет review feedback и создаёт новую video revision branch. Application-level blind retry cap для human-requested revision не используется; новая трата происходит только вследствие явного human decision.

Если ни одна reference image не была approved, workflow завершается без video spend.

## 17. Assembly

Assembly запускается только после Human Video Gate.

Current v1 assembly invariant:

- минимум одно human-approved gameplay video;
- video обязано ссылаться на current human-approved reference generation;
- concept/moment/shot lineage должна совпадать;
- сейчас поддерживается **один evidence video shot per concept** для prototype assembly.

Multishot assembly для одного concept пока намеренно не поддержан и fail'ит явно.

FFmpeg выполняется в durable worker/VPS path, а не в browser/Vercel. Assembly artifact и asset graph сохраняют lineage до source reference, image generation и video generation.

После assembly root run получает `prototype_result` и завершается.

## 18. Human feedback memory

Human feedback является durable evidence, а не временным chat context.

Сохраняются:

- raw review;
- approve/revise/reject;
- structured error tags;
- `mustShow`;
- `mustAvoid`;
- scope;
- generation/revision lineage.

При следующем prompt compilation релевантные ограничения возвращаются в image/video prompts. Это текущий learning mechanism Stage 4: explicit evidence-backed constraints, а не opaque fine-tuning.

## 19. Stop / cancellation

Production Stop реализован как durable cascade cancellation.

Цель invariants:

- Stop запрещает новые paid submits для cancelled lineage;
- активный provider/search/fetch work получает AbortSignal;
- lease heartbeat быстро обнаруживает снятый lease и abort'ит in-flight tick;
- retries не должны воскресить cancelled job;
- child jobs cancellation follows root lineage.

Это важнее UI-анимации кнопки: авторитет — durable DB cancellation state.

## 20. Live Research Trace

Research progress хранится durable events и стримится в UI. Shared-pool acquisition публикует события:

- search started/completed;
- source accepted/rejected;
- identity mismatch/duplicate;
- coverage recovery started/completed/failed;
- pool ready;
- provider-call count/cap;
- search and Safe Fetch timing.

UI должен показывать фактическую исследовательскую работу, но trace не является источником workflow truth.

## 21. Early finalize / «Ответить сейчас»

Research hardening содержит explicit early-finalize boundary: раннее завершение разрешается только когда coverage/evidence eligibility выполнена. Остаточная research work должна отменяться, а итог обязан сохранять признак early-finalized run.

Для simplified v3 current default creative path главная защита всё равно — bounded shared source pool; early finalize не должен превращаться в обход minimum evidence gate.

## 22. Provider/model routing snapshot

### Research and concept

| Task | Model / path |
|---|---|
| grounded source acquisition | KIE `gemini-3-6-flash` + Google Search, minimal thinking |
| strong v3 concept synthesis | KIE `gpt-5-6-terra`, medium reasoning mapping |

### Stage 4 downstream

| Task | Default |
|---|---|
| gameplay moment planning | `gemini-3-pro` |
| moment/schema repair | `gemini-3-6-flash` |
| shot planning | `gemini-3-6-flash` |
| shot escalation on deterministic failure | one bounded `gemini-3-pro` |
| feedback structuring | `gemini-3-6-flash` |
| reference captioning | `gemini-3-6-flash`, max one caption call |
| gameplay still | `gpt-image-2` |
| gameplay video | `minimax-h3` / KIE Hailuo 03 |
| video fallback | `kling-3` |

Stage 4's own `model-policy.ts` не разрешает automatic top-tier escalation. V3 strong concept model — отдельный explicit production policy outside that Stage 4 task router.

## 23. Storage and archive

Supabase хранит execution/evidence/lineage metadata.

Google Drive — durable archive для knowledge originals, curated reference originals и completed media archive path. Production deploy требует working owner OAuth и configured shared archive root.

Backblaze B2 остаётся temp asset-ingest storage для соответствующего ingest path, не authoritative long-term discovery memory.

Local VPS filesystem используется для temporary/shared assembly staging/output, но durable product truth не должен существовать только на локальном диске worker'а.

## 24. Release and schema fence

CI для exact commit выполняет:

- shell syntax / schema contract checks;
- lint;
- app typecheck;
- worker TypeScript compile;
- durable worker Docker build;
- FFmpeg/ffprobe runtime check;
- full Vitest suite;
- Next production build.

Production deploy запускается после successful `CI` on `main`.

Перед Docker deployment `scripts/deploy.sh` читает `supabase/schema-contract.txt` и сравнивает его с production RPC `orchestrator_get_deployment_schema_contract`.

Если DB schema отстаёт от application fence — deployment **блокируется**. Поэтому migration-first для нового schema contract является обязательным.

После deploy проверяется:

- app health;
- worker running;
- assembly workspace permissions;
- Drive OAuth/archive access;
- media archive backfill;
- newest `orchestrator_workers.build_sha`.

Rollback candidate и last-good commit сохраняются на VPS.

## 25. Current known limitations

Это ограничения текущей реализации, а не скрытые promises:

- v3 использует один shared source acquisition pool; старые 5 Scouts/Council остаются только как v2 compatibility path;
- player_voice web coverage зависит от Safe-Fetchable public pages; Reddit сейчас сознательно исключён;
- one evidence shot per concept в текущем assembly;
- no native audio requirement для discovery gameplay video;
- no automatic AI rejection после image/video generation;
- reference embeddings/vector retrieval infrastructure существует, но не является основным populated production path;
- H3 ещё должен пройти отдельную содержательную quality acceptance на реальном 10-second chat run; code/provider wiring и production deployment уже готовы;
- Stage 5 evaluator и Stage 6 learning loop ещё не являются production authority.

## 26. Что считать regression

Следующие изменения должны считаться архитектурным regression, если они не одобрены отдельно:

- queue message становится source of truth вместо DB;
- paid video submit возможен без Human Image Gate;
- assembly использует не human-approved video;
- generated media auto-rejected AI вместо человека;
- creative LLM сам меняет provider/model policy;
- KIE search prose без verifiable provenance принимается как evidence;
- external page instruction становится trusted prompt instruction;
- blind paid retry скрывает provider/schema failure;
- H3 prompt снова обрезается после compilation;
- cinematic camera intent подменяет player-visible gameplay camera;
- new schema app deploy проходит при production DB drift.

## 27. Где смотреть код

- `lib/agent/tools/resolve-tools-for-turn.ts` — natural chat intent routing;
- `lib/agent/tools/game-discovery.ts` — v3 admission;
- `worker/workflows/game-discovery-batch-v3.ts` — current production discovery front-end;
- `lib/research-intelligence/shared-source-pool.ts` — bounded verified source acquisition;
- `lib/research-intelligence/shared-pool-kie-search.ts` — KIE Google-grounded search adapter;
- `lib/research-intelligence/game-discovery-v3.ts` — Research Pack + strong concept synthesis;
- `lib/game-discovery/moment-planner.ts` — gameplay moment + camera rules;
- `lib/game-discovery/shot-planner.ts` — deterministic generation policy + authenticity contract;
- `lib/game-discovery/prompt-compiler.ts` — image/H3 prompt compiler;
- `worker/workflows/game-discovery-batch-stage4-reference-integrated-v1.ts` — references + pre-media gates;
- `worker/workflows/game-discovery-batch-stage4-video-v1.ts` — approved video + Human Video Gate;
- `worker/workflows/game-discovery-batch-stage4-assembly-v1.ts` — FFmpeg assembly/finalization;
- `worker/main.ts` / `worker/config.ts` — durable worker runtime;
- `supabase/migrations/` — authoritative DB evolution;
- `.github/workflows/ci.yml` / `deploy-production.yml` / `scripts/deploy.sh` — release path.
