-- Stage 3 provider-path performance hygiene.
-- Cover foreign keys that are exercised by reconciliation, lineage repair and cost tracing.
-- Additive indexes only; no query semantics or authorization changes.

CREATE INDEX IF NOT EXISTS idx_provider_tasks_stage_id
  ON public.provider_tasks (stage_id);

CREATE INDEX IF NOT EXISTS idx_provider_tasks_provider_model_id
  ON public.provider_tasks (provider_model_id);

CREATE INDEX IF NOT EXISTS idx_factory_cost_events_provider_task_id
  ON public.factory_cost_events (provider_task_id);

CREATE INDEX IF NOT EXISTS idx_factory_cost_events_stage_id
  ON public.factory_cost_events (stage_id);

CREATE INDEX IF NOT EXISTS idx_factory_workflow_events_stage_id
  ON public.factory_workflow_events (stage_id);
