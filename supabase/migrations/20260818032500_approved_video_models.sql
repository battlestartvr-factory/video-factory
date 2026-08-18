-- Approved durable video provider catalog.
-- Prices are intentionally empty until dated, verified KIE pricing evidence is stored.

UPDATE public.provider_models
SET enabled = false
WHERE provider = 'kie'
  AND capability = 'video';

INSERT INTO public.provider_models (
  id, provider, capability, preset, model, endpoint, enabled, priority, parameters, estimated_cost
)
VALUES
  (
    '20000000-0000-4000-8000-000000000041'::uuid,
    'kie', 'video', 'balanced', 'kling-3',
    'https://api.kie.ai/api/v1/jobs/createTask', true, 10,
    jsonb_build_object(
      'api_style', 'unified_jobs',
      'provider_model', 'kling-3.0/video',
      'durable_workflow', 'generation_video@1'
    ),
    '{}'::jsonb
  ),
  (
    '20000000-0000-4000-8000-000000000042'::uuid,
    'kie', 'video', 'balanced', 'veo-3-1',
    'https://api.kie.ai/api/v1/veo/generate', true, 20,
    jsonb_build_object(
      'api_style', 'veo',
      'durable_workflow', 'generation_video@1'
    ),
    '{}'::jsonb
  ),
  (
    '20000000-0000-4000-8000-000000000043'::uuid,
    'kie', 'video', 'balanced', 'seedance-2-5',
    'https://api.kie.ai/api/v1/jobs/createTask', true, 30,
    jsonb_build_object(
      'api_style', 'unified_jobs',
      'provider_model', 'bytedance/seedance-2-5',
      'durable_workflow', 'generation_video@1'
    ),
    '{}'::jsonb
  ),
  (
    '20000000-0000-4000-8000-000000000044'::uuid,
    'kie', 'video', 'balanced', 'wan-2-7',
    'https://api.kie.ai/api/v1/jobs/createTask', true, 40,
    jsonb_build_object(
      'api_style', 'unified_jobs',
      'provider_model_family', 'wan/2-7-*',
      'durable_workflow', 'generation_video@1'
    ),
    '{}'::jsonb
  )
ON CONFLICT (provider, capability, preset, model)
DO UPDATE SET
  endpoint = EXCLUDED.endpoint,
  enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority,
  parameters = EXCLUDED.parameters,
  estimated_cost = EXCLUDED.estimated_cost;
