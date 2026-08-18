-- Approved image provider catalog for the generator surface.
-- Nano Banana 2 Lite and the older exploratory image models are intentionally disabled.
-- Stage 3 pricing evidence is maintained separately on durable provider_tasks; do not place
-- speculative pricing in provider_models.

UPDATE public.provider_models
SET enabled = false
WHERE provider = 'kie'
  AND capability = 'image';

INSERT INTO public.provider_models (
  id,
  provider,
  capability,
  preset,
  model,
  endpoint,
  enabled,
  priority,
  parameters,
  estimated_cost
)
VALUES
  (
    '20000000-0000-4000-8000-000000000022'::uuid,
    'kie',
    'image',
    'balanced',
    'gpt-image-2',
    'https://api.kie.ai/api/v1/jobs/createTask',
    true,
    10,
    jsonb_build_object('api_style', 'unified_jobs', 'durable_workflow', 'generation_image@1'),
    '{}'::jsonb
  ),
  (
    '20000000-0000-4000-8000-000000000023'::uuid,
    'kie',
    'image',
    'balanced',
    'nano-banana-2',
    'https://api.kie.ai/api/v1/jobs/createTask',
    true,
    20,
    jsonb_build_object('api_style', 'unified_jobs', 'durable_workflow', 'generation_image@1'),
    '{}'::jsonb
  ),
  (
    '20000000-0000-4000-8000-000000000024'::uuid,
    'kie',
    'image',
    'balanced',
    'nano-banana-pro',
    'https://api.kie.ai/api/v1/jobs/createTask',
    true,
    30,
    jsonb_build_object('api_style', 'unified_jobs', 'durable_workflow', 'generation_image@1'),
    '{}'::jsonb
  )
ON CONFLICT (provider, capability, preset, model)
DO UPDATE SET
  endpoint = EXCLUDED.endpoint,
  enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority,
  parameters = EXCLUDED.parameters,
  estimated_cost = EXCLUDED.estimated_cost;

-- Explicit belt-and-suspenders guard for the old WF21 seed.
UPDATE public.provider_models
SET enabled = false
WHERE provider = 'kie'
  AND capability = 'image'
  AND model = 'nano-banana-2-lite';
