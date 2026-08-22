# Future Roadmap — хотелки, идеи и следующие продуктовые слои

**Статус:** future / not implemented unless explicitly marked otherwise  
**Обновлено:** 2026-08-22

Этот файл специально отделён от `implementation-current.md`, чтобы будущие идеи не выглядели как уже работающий production contract.

Главный принцип roadmap:

> Делать только то, что повышает вероятность найти, проверить и улучшить сильную PC/Steam co-op идею. Не превращать завод в коллекцию AI-фич ради самих AI-фич.

## 1. Ближайший quality checkpoint: реальный H3 acceptance

Первый следующий продуктовый тест — не новая архитектура, а один контролируемый реальный run:

1. natural chat request;
2. v3 research;
3. exactly 3 concepts;
4. Human Concept Gate;
5. one approved gameplay still;
6. Human Image Gate;
7. one **10-second MiniMax H3 / Hailuo 03** video through KIE;
8. Human Video Gate;
9. record quality + actual cost.

Что измерять:

- сохраняется ли approved frame-0;
- остаётся ли камера gameplay camera;
- понятен ли player input;
- правильно ли происходит world response;
- читается ли co-op dependency;
- нет ли cinematic drift;
- нет ли identity/object/geometry drift;
- проходит ли человек результат с первого раза;
- actual provider cost;
- **cost per accepted gameplay shot**, а не только cost per generation.

Если H3 не даёт нужного качества, Kling остаётся немедленным baseline/fallback.

## 2. Provider-aware video compiler

Сейчас H3 имеет отдельный prompt profile, Kling остаётся generic fallback. Следующий архитектурно чистый шаг, если появится необходимость сравнивать модели:

```text
GameplayMomentSpec
  -> ShotSpec
  -> GameplayVideoMotionPlan
  -> provider-neutral semantic package
  -> provider compiler
       minimax_h3
       kling
       future_seedance
       future_gemini_video
```

Цель — не четыре разных Planner'а, а один product meaning + несколько дешёвых provider-specific compilers.

Для каждого provider profile хранить:

- prompt budget;
- supported duration/resolution;
- first/last/reference frame semantics;
- camera-control syntax;
- negative-prompt semantics;
- cost estimate;
- provider quirks;
- acceptance stats.

## 3. Video model bake-offs

Не менять default только по публичному leaderboard.

Будущий model bake-off должен использовать одинаковые:

- approved still;
- typed motion plan;
- duration;
- aspect ratio;
- human acceptance rubric.

Кандидаты для controlled experiments:

- MiniMax H3 — current primary;
- Kling 3 — current fallback/baseline;
- Seedance — specialist candidate для сложной physics/multi-actor motion;
- Gemini video family — challenger, если KIE path и economics оправданы.

Primary metric:

`provider spend / human-approved usable shot`

Secondary:

- first-attempt pass rate;
- camera drift rate;
- motion correctness;
- artifact defect rate;
- latency.

## 4. Stage 5 — Gameplay Quality Evaluation

Stage 5 нужен, чтобы перестать смешивать две разные причины плохого результата:

### A. Game idea defect

Например:

- co-op dependency на самом деле слабая;
- mechanic boring/repetitive;
- failure не создаёт social reaction;
- момент трудно понять даже при хорошем render;
- идея похожа на существующий рынок без достаточного difference.

### B. Artifact/model defect

Например:

- camera стала cinematic;
- персонажи morph'ятся;
- модель неправильно исполнила физику;
- HUD/geometry drift;
- shot плохо скомпилирован;
- reference image неудачный.

Stage 5 evaluator должен явно различать эти классы. Плохое видео не должно автоматически убивать хорошую game hypothesis.

### Предлагаемые dimensions

- core mechanic clarity;
- co-op necessity;
- social tension / player reaction;
- failure readability;
- recovery/readability;
- novelty / closest analog;
- buildability;
- session/replay potential;
- visual prototype fidelity;
- gameplay-camera authenticity.

### Human decision layer

Полезный high-level verdict:

- `Love` — хочется продолжать;
- `Maybe` — есть сильное ядро, нужен следующий experiment;
- `Reject` — hypothesis не выдержала evidence.

AI может предлагать evidence-backed analysis, но product decision должен оставаться inspectable и human-overridable.

## 5. Stage 6 — Learning / Memory Loop

Stage 4 уже сохраняет review feedback. Stage 6 должен превратить накопленные результаты в измеримое обучение между batches.

Не нужен «магический autonomous memory». Нужны атомарные evidence-backed learnings:

```text
observation
  -> evidence links
  -> confidence
  -> scope
  -> repeated support / contradiction
  -> promotion to durable memory
```

Примеры:

- какие co-op dependencies люди чаще approve;
- какие camera grammars дают лучший Human Image pass rate;
- какие prompt patterns уменьшают cinematic drift;
- какие visual references реально помогают;
- какие mechanics дают social moments;
- какой provider дешевле на accepted shot;
- какие research source families дают полезные concepts.

### Learning Lift

Нужна метрика, которая показывает, стал ли следующий batch лучше предыдущего.

Возможные компоненты:

- concept approval rate;
- first-pass image approval rate;
- first-pass video approval rate;
- artifact defect rate;
- idea rejection rate;
- average provider spend per accepted concept/shot;
- number of revisions;
- human `Love` rate;
- novelty/buildability composite.

## 6. Better Gameplay Reference Library

Текущая library уже полезна, но следующий слой может дать большой quality lift.

### Embeddings and vector retrieval

Инфраструктура vector RPC существует; future work:

- выбрать embedding provider;
- заполнить embeddings для current references;
- backfill future references при ingest;
- включить semantic vector retrieval как production signal;
- сравнить vector retrieval с lexical/purpose heuristics.

### Purpose quality

Улучшать не количество картинок, а покрытие:

- first-person interaction;
- third-person follow interaction;
- over-shoulder mechanics;
- physics manipulation;
- two-player dependency;
- four-player readable chaos;
- failure/recovery;
- compact HUD affordances;
- indie/AA material/art examples.

### Reference effectiveness learning

Хранить связь:

`reference -> generated still -> human decision`

Это позволит со временем понимать, какие references реально помогают, а какие просто похожи визуально.

## 7. Research improvements

V3 shared source pool специально ограничен. Улучшения должны сохранять bounded cost и provenance.

### Player voice coverage

Текущий Safe Fetch не использует Reddit из-за 403. Возможные будущие решения:

- отдельный authorised/community-search connector;
- источники Steam Community с более устойчивым parser/fetch;
- дополнительные публичные forum providers;
- официальные platform APIs, если economics/terms подходят.

Нельзя решать проблему снятием provenance/safety gate.

### Source cache

Развить reuse verified sources между близкими discovery runs:

- TTL/freshness by claim type;
- content hash invalidation;
- source quality score;
- avoid повторных KIE searches, когда fresh evidence уже есть.

### Evidence usefulness

Вместо «больше источников» оценивать:

- был ли source реально использован concept model;
- помог ли он сделать intentional difference;
- изменил ли Human Gate decision;
- дал ли он useful gameplay reference pattern.

## 8. Stage 7 — Market Intelligence

Stage 7 имеет смысл только после Stage 5/6, когда factory умеет учиться на собственных experiments.

Future scope:

- periodic competitor updates;
- Steam category/co-op trend snapshots;
- pricing/review/player-count signals;
- recurring mechanic saturation checks;
- release/watch lists;
- structured change detection.

Это должен быть отдельный bounded intelligence product, а не background crawler без цели.

## 9. Multi-shot gameplay prototypes

Current assembly intentionally supports one evidence shot per concept.

Будущий v2 assembly:

- 2–3 short evidence moments per concept;
- explicit continuity contract;
- optional first/last-frame linking;
- deterministic order;
- per-shot Human Gate;
- no montage that hides mechanic readability.

Причина делать multishot — проверить несколько hypotheses, а не превратить evidence в trailer.

## 10. Longer / higher-resolution media

Не повышать resolution/duration автоматически.

Upgrade только если human evidence показывает benefit.

Возможные tiers:

- cheap discovery: 768/720p, 5–10s;
- normal prototype: 10s 768/1080p;
- selected concept showcase: 10–15s 1080p/2K;
- long sequence only after concept earns it.

Критерий — quality-adjusted cost.

## 11. Audio

Native video audio сейчас не нужен для core gameplay hypothesis.

Future audio layer можно добавить после visual acceptance:

- player VO/reaction mock;
- game SFX;
- spatial cue evidence;
- failure/success audio feedback.

Audio должен быть отдельным optional evidence dimension, а не обязательной дорогой частью каждого discovery shot.

## 12. Better Human Gate UX

Полезные улучшения `/discovery`:

- side-by-side reference revision compare;
- video revision compare;
- exact prompt/model/cost expandable details;
- one-click reason tags + free text;
- show what previous feedback was applied;
- direct link from output artifact to source lineage;
- clear «что будет стоить денег после Approve»;
- batch keyboard review.

Не перегружать основную карточку техническими полями — details должны быть inspectable, но progressive disclosure.

## 13. Cost dashboard

Нужен отдельный factory economics view:

- KIE search calls/run;
- concept LLM tokens;
- image attempts/approved image;
- video attempts/approved video;
- cost per concept approved;
- cost per accepted gameplay shot;
- cost per `Love` concept;
- cost saved by pre-generation gates / Stop.

Важно отличать provider estimate от фактически подтверждённого billing, если provider API не отдаёт точную charge record.

## 14. Experiment registry

Вместо ручного сравнения моделей можно добавить lightweight experiment table:

- experiment id;
- hypothesis;
- provider/model/compiler version;
- fixed inputs;
- generation settings;
- human scores;
- cost/latency;
- winner/decision;
- rollout status.

Так model/provider changes не будут теряться в chat history.

## 15. Automated regression canaries

После unit/contract tests можно добавить очень дешёвые production canaries:

- no-cost admission/schema canary;
- KIE auth/provider catalogue check;
- optional tiny paid search canary on explicit schedule;
- optional controlled image/video canary only after human approval.

Не запускать дорогие media canaries на каждый commit.

## 16. Documentation drift checks

После текущего большого docs refresh имеет смысл добавить CI checks:

- canonical docs mention current workflow version;
- current primary video model matches code constant;
- documented schema contract matches `supabase/schema-contract.txt`;
- stale forbidden phrases such as «Vercel production», «Kling primary», «9:16 gameplay source» fail docs lint outside `Historical` sections;
- every historical contract has a superseded banner.

Цель — не perfect prose lint, а защита от опасной архитектурной путаницы.

## 17. Stronger release acceptance

Для provider/model changes release checklist может требовать:

1. contract tests;
2. full CI;
3. migration applied;
4. deploy exact SHA;
5. fresh worker heartbeat with exact SHA;
6. provider registry SQL check;
7. one controlled real acceptance when change affects paid output quality;
8. explicit human verdict recorded.

## 18. Provider health routing

Kling уже сохранён как fallback, но automatic failover пока не должен бесконтрольно тратить деньги.

Future policy:

- classify provider failure vs content failure;
- only technical/provider-unavailable error can qualify for automatic fallback;
- maximum one fallback provider submit;
- preserve same typed motion plan;
- log reason and extra cost;
- human/content rejection never triggers automatic provider hopping.

## 19. Research-to-reference bridge

External web visual research и curated Gameplay Reference Library сейчас разделены намеренно.

Future controlled bridge:

- detect genuine gameplay screenshots/video frames in verified research;
- archive source provenance;
- human/curator promotion decision;
- dedupe against current library;
- caption/index once;
- never auto-promote marketing/key art.

## 20. Better concept diversity

Exactly 3 v3 concepts — хороший human review size. Можно улучшить не count, а diversity quality:

- explicit pairwise mechanic-distance check;
- compare core player verbs, dependency type, failure topology, camera/readability, social tension;
- if two concepts are near duplicates, deterministic reject + one bounded replacement request;
- preserve original user constraints.

Не возвращаться к генерации 12–30 ideas просто ради количества.

## 21. Concept iteration after Human Gate

`Revise` может стать более структурированным:

- human selects what to keep;
- human states what must change;
- one strong revision model sees full approved concept + feedback + research pack;
- new concept revision lineage is explicit;
- old revision remains inspectable;
- only approved revision proceeds.

## 22. Production observability

Useful operational views:

- active workers/build SHA/heartbeat;
- queue depth core/research;
- due/retrying/cancelled jobs;
- KIE provider call latency/errors;
- Safe Fetch rejection reasons;
- current schema contract;
- Drive archive backlog;
- assembly failures;
- human-gate waiting age.

Можно сделать internal `/ops` page или admin-only diagnostics API.

## 23. Security hardening

Future review areas:

- rotate/shorten provider secrets where supported;
- central secret inventory health without displaying values;
- explicit egress allowlist for internal fetch paths;
- SSRF regression corpus;
- provider callback verification where used;
- periodic RLS/advisor checks;
- retention policy for temporary fetched content.

## 24. Generic content-factory features

Старое MVP ТЗ включало scripts/posts/dev diaries/marketing content. Эти функции могут оставаться в repo, но **не должны перехватывать core discovery roadmap**.

Если возвращать их в активную разработку, лучше оформить отдельный product lane:

`Content Production Factory`

а не смешивать его с:

`Co-op Game Discovery Factory`.

Общими могут быть auth, projects, agent UI, generations, storage and provider registry; product evaluation/memory loops должны быть разными.

## 25. Что сейчас НЕ планируется делать автоматически

- autonomous unbounded web crawling;
- infinite Scout/agent debates;
- automatic training/fine-tuning from every reject;
- automatic paid media regeneration after human rejection;
- automatic move to most expensive model;
- automatic copy of web/game references into generated assets;
- automatic upload of every external image into Gameplay Reference Library;
- cinematic trailer production before gameplay hypothesis passes.

## 26. Suggested priority order

Если идти от максимального product value к инфраструктурным улучшениям:

1. **real 10s H3 acceptance**;
2. fix only the quality defects this test actually reveals;
3. Stage 5 evaluator: idea defect vs artifact defect;
4. cost-per-accepted-shot instrumentation;
5. Stage 6 evidence-backed learning loop;
6. reference embeddings/effectiveness learning;
7. multi-shot prototypes for concepts that earned more evidence;
8. controlled provider bake-offs;
9. Stage 7 market intelligence;
10. optional generic content-production lane.

Этот порядок намеренно не обещает реализацию всех идей. Каждый следующий слой должен быть оправдан evidence от предыдущего.