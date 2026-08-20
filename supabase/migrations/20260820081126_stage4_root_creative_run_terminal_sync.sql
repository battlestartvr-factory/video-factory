-- Stage 4 closeout: keep root creative-run lineage terminal state in lockstep with its factory job.
-- The trigger is generic for root creative runs and deliberately ignores child concept/media runs.

CREATE OR REPLACE FUNCTION public.sync_factory_job_root_creative_run_terminal_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NEW.status IN ('completed', 'failed', 'cancelled')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE public.creative_runs AS cr
    SET status = NEW.status,
        completed_at = COALESCE(cr.completed_at, NEW.completed_at, NOW()),
        updated_at = NOW()
    WHERE cr.factory_job_id = NEW.id
      AND cr.parent_run_id IS NULL
      AND cr.status NOT IN ('completed', 'failed', 'cancelled');
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS factory_jobs_sync_root_creative_run_terminal ON public.factory_jobs;
CREATE TRIGGER factory_jobs_sync_root_creative_run_terminal
AFTER UPDATE OF status ON public.factory_jobs
FOR EACH ROW
EXECUTE FUNCTION public.sync_factory_job_root_creative_run_terminal_v1();

-- One-time repair of historical factory lineage that became terminal before this invariant existed.
-- Child creative runs are intentionally excluded.
UPDATE public.creative_runs AS cr
SET status = fj.status,
    completed_at = COALESCE(cr.completed_at, fj.completed_at, NOW()),
    updated_at = NOW()
FROM public.factory_jobs AS fj
WHERE cr.factory_job_id = fj.id
  AND cr.parent_run_id IS NULL
  AND fj.status IN ('completed', 'failed', 'cancelled')
  AND cr.status NOT IN ('completed', 'failed', 'cancelled');

COMMENT ON FUNCTION public.sync_factory_job_root_creative_run_terminal_v1()
IS 'Synchronizes a terminal factory_jobs status to its non-terminal root creative_run; child creative runs are intentionally untouched.';
