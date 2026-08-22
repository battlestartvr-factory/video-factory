-- HISTORICAL admin-only provider_models seed template.
-- Current provider catalogue is evolved by versioned Supabase migrations, not by manually
-- filling this file. In particular, current gameplay video primary is `minimax-h3` mapped
-- to KIE `minimax/hailuo-03`; Kling 3 remains enabled fallback/baseline.
--
-- Keep this template only as a reminder of the provider_models shape. Never use it to bypass
-- the schema contract, migration history, provider verification, or production admission gates.

/*
INSERT INTO public.provider_models (
  provider,
  capability,
  preset,
  model,
  endpoint,
  enabled,
  parameters,
  priority,
  estimated_cost
) VALUES
(
  'kie',
  'llm',
  'balanced',
  'FILL_ME',
  'FILL_ME_FROM_VERIFIED_PROVIDER_CONTRACT',
  false,
  '{}'::jsonb,
  100,
  '{}'::jsonb
),
(
  'kie',
  'image',
  'balanced',
  'FILL_ME',
  'FILL_ME_FROM_VERIFIED_PROVIDER_CONTRACT',
  false,
  '{}'::jsonb,
  100,
  '{}'::jsonb
),
(
  'kie',
  'video',
  'balanced',
  'FILL_ME',
  'FILL_ME_FROM_VERIFIED_PROVIDER_CONTRACT',
  false,
  '{}'::jsonb,
  100,
  '{}'::jsonb
);
*/
