# AI Content Factory — original Cursor MVP specification

> **ARCHIVED / SUPERSEDED.**  
> This file originally described the March 2026 generic content-factory MVP based on Vercel + n8n + OpenRouter/fal.ai assumptions. It is retained as historical context only.  
> It is **not the current source of requirements**.

## Current sources of truth

Read instead:

1. `docs/implementation-current.md` — actual current implementation;
2. `docs/current-project-state.md` — operational handoff;
3. `docs/future-roadmap.md` — future ideas, explicitly not current behavior;
4. `docs/architecture.md` — current VPS/Supabase/KIE/worker architecture;
5. `docs/deployment.md` — current release path.

## What the original document established

The initial MVP specification defined a useful foundation:

- authenticated internal team UI;
- projects/jobs/assets;
- Supabase Auth/Postgres/RLS;
- Next.js App Router UI/API;
- Google Drive source/archive integration;
- model/provider abstraction;
- cost/usage visibility;
- review/retry/cancel UX;
- server-side secret boundaries;
- TypeScript/Vitest/Playwright engineering baseline.

Those ideas influenced the current repository.

## What is now obsolete

Do not use the following original assumptions for new implementation work:

- **Vercel as production runtime** — production is Ubuntu VPS + Docker Compose + Caddy;
- **n8n as owner of long-running workflow state** — current Discovery uses durable `factory_jobs`, `creative_runs`, PGMQ and workers;
- **OpenRouter as canonical LLM provider** — current provider layer is KIE;
- **fal.ai as canonical image/video provider** — current Discovery media goes through KIE provider models;
- **future VDS worker** — durable worker containers are production now;
- **generic content generation as the project's North Star** — current primary product is PC/Steam co-op Game Discovery;
- old `*.vercel.app` callback/deployment examples.

## Current product lane

Current primary product:

`AI Co-op Game Discovery Factory`

```text
natural chat request
 -> verified external research
 -> exactly 3 game concepts
 -> Human Concept Gate
 -> gameplay evidence planning
 -> GPT Image 2 still
 -> Human Image Gate
 -> MiniMax H3 gameplay video
 -> Human Video Gate
 -> FFmpeg prototype assembly
 -> evidence lineage
```

Generic scripts/posts/dev diaries may still exist as legacy code/product capability, but future work on that lane must be planned separately from the Discovery roadmap.

## Historical source

The full original specification remains available in Git history before the 2026-08-22 documentation consolidation. Use history only when investigating an old implementation decision or legacy generic-content route.