-- Idempotent seed: KIE nano-banana-2-lite as the enabled balanced image model for WF21.
-- Schema is unchanged. Existing rows are never deleted.
-- API keys, webhook HMAC, and other secrets are not stored in this table.
-- KIE API is not called by this migration.

insert into public.provider_models (
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
values (
  '20000000-0000-4000-8000-000000000021'::uuid,
  'kie',
  'image',
  'balanced',
  'nano-banana-2-lite',
  'https://api.kie.ai/api/v1/jobs/createTask',
  true,
  1,
  jsonb_build_object(
    'api_style', 'unified_jobs',
    'callback_url',
    'https://battlestartvr.app.n8n.cloud/webhook/factory/kie-callback',
    'request_defaults', jsonb_build_object(
      'input', jsonb_build_object(
        'image_urls', '[]'::jsonb
      )
    ),
    'allowed_result_hosts', jsonb_build_array(
      'file.aiquickdraw.com',
      'tempfile.aiquickdraw.com'
    )
  ),
  jsonb_build_object(
    'default_usd', 0.02,
    'usd', 0.02,
    'usd_per_image_1k', 0.02
  )
)
on conflict (provider, capability, preset, model)
do update set
  endpoint = excluded.endpoint,
  enabled = excluded.enabled,
  priority = excluded.priority,
  parameters = excluded.parameters,
  estimated_cost = excluded.estimated_cost;

-- Keep WF21 selection deterministic: only this KIE balanced image model stays enabled.
update public.provider_models
set enabled = false
where provider = 'kie'
  and capability = 'image'
  and preset = 'balanced'
  and model <> 'nano-banana-2-lite';
