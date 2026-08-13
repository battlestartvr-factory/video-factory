-- Idempotent seed: KIE Gemini 3 Flash as the enabled economy LLM for WF20.
-- Schema is unchanged. Existing rows are never deleted.
-- API keys and other secrets are not stored in this table.

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
  '20000000-0000-4000-8000-000000000002'::uuid,
  'kie',
  'llm',
  'economy',
  'gemini-3-flash',
  'https://api.kie.ai/gemini-3-flash/v1/chat/completions',
  true,
  1,
  jsonb_build_object(
    'api_style', 'chat_completions',
    'request_defaults', jsonb_build_object(
      'temperature', 0.2
    ),
    'system_prompt',
    'Return only the final answer. For script or structured content stages return strict valid JSON without Markdown fences. Do not include commentary outside the JSON.',
    'allowed_result_hosts', '[]'::jsonb
  ),
  jsonb_build_object(
    'default_usd', 0.01,
    'input_usd_per_million', 0.15,
    'output_usd_per_million', 0.90
  )
)
on conflict (provider, capability, preset, model)
do update set
  endpoint = excluded.endpoint,
  enabled = excluded.enabled,
  priority = excluded.priority,
  parameters = excluded.parameters,
  estimated_cost = excluded.estimated_cost;

-- Keep WF20 selection deterministic: only this KIE economy LLM stays enabled.
update public.provider_models
set enabled = false
where provider = 'kie'
  and capability = 'llm'
  and preset = 'economy'
  and model <> 'gemini-3-flash';
