-- Idempotent seed: KIE bytedance/v1-lite-image-to-video as the enabled balanced video model for WF22.
-- Schema is unchanged. Existing rows are never deleted.
-- API keys, Bearer tokens, webhook HMAC, and other secrets are not stored in this table.
-- KIE API is not called by this migration.
-- estimated_cost is a temporary conservative test ceiling for budget-check, not a verified production price.

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
  '20000000-0000-4000-8000-000000000022'::uuid,
  'kie',
  'video',
  'balanced',
  'bytedance/v1-lite-image-to-video',
  'https://api.kie.ai/api/v1/jobs/createTask',
  true,
  1,
  jsonb_build_object(
    'api_style', 'unified_jobs',
    'callback_url',
    'https://battlestartvr.app.n8n.cloud/webhook/factory/kie-callback',
    'request_defaults', jsonb_build_object(
      'input', jsonb_build_object(
        'resolution', '720p',
        'duration', '5',
        'camera_fixed', false,
        'seed', -1,
        'enable_safety_checker', true,
        'end_image_url', '',
        'nsfw_checker', false
      )
    ),
    'allowed_result_hosts', jsonb_build_array(
      'file.aiquickdraw.com',
      'tempfile.aiquickdraw.com',
      'tempfile.redpandaai.co'
    )
  ),
  jsonb_build_object(
    'default_usd', 0.20,
    'usd', 0.20,
    'pricing_note',
    'temporary conservative test ceiling; replace with verified current KIE price before production'
  )
)
on conflict (provider, capability, preset, model)
do update set
  endpoint = excluded.endpoint,
  enabled = excluded.enabled,
  priority = excluded.priority,
  parameters = excluded.parameters,
  estimated_cost = excluded.estimated_cost;

-- Keep WF22 selection deterministic: only this KIE balanced video model stays enabled.
update public.provider_models
set enabled = false
where provider = 'kie'
  and capability = 'video'
  and preset = 'balanced'
  and model <> 'bytedance/v1-lite-image-to-video';
