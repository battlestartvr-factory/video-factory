-- Parked waiting jobs (for example human reference approval) have no timer and
-- must not be periodically re-enqueued by the watchdog. Timed waiting/retrying
-- work remains recoverable, and queued work may still be repaired if its timer is
-- absent or already due.

CREATE OR REPLACE FUNCTION public.orchestrator_watchdog_recover(
  p_limit integer DEFAULT 50,
  p_reenqueue_after_seconds integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pgmq'
AS $function$
DECLARE
  v_job RECORD;
  v_msg_id BIGINT;
  v_recovered INTEGER := 0;
  v_stale_leases INTEGER := 0;
BEGIN
  IF p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'limit must be between 1 and 500'; END IF;
  IF p_reenqueue_after_seconds<15 OR p_reenqueue_after_seconds>3600 THEN RAISE EXCEPTION 'reenqueue_after_seconds must be between 15 and 3600'; END IF;

  FOR v_job IN
    SELECT fj.id,fj.status,fj.lease_token,fj.lease_expires_at
    FROM public.factory_jobs fj
    WHERE (
      (
        (fj.status='queued' AND (fj.next_action_at IS NULL OR fj.next_action_at<=NOW()))
        OR
        (fj.status IN ('waiting','retrying') AND fj.next_action_at IS NOT NULL AND fj.next_action_at<=NOW())
      )
      AND (fj.last_enqueued_at IS NULL OR fj.last_enqueued_at<=NOW()-make_interval(secs=>p_reenqueue_after_seconds))
    ) OR (
      fj.status='running' AND fj.lease_expires_at IS NOT NULL AND fj.lease_expires_at<=NOW()
    )
    ORDER BY COALESCE(fj.next_action_at,fj.lease_expires_at,fj.created_at),fj.created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    IF v_job.status='running' THEN
      v_stale_leases:=v_stale_leases+1;
      UPDATE public.factory_job_stages
      SET status='interrupted',
          finished_at=COALESCE(finished_at,NOW()),
          error=COALESCE(error,jsonb_build_object('code','STALE_LEASE','message','Worker lease expired'))
      WHERE job_id=v_job.id AND status IN ('running','submitted','processing');

      UPDATE public.factory_jobs
      SET status='queued',
          state_reason='watchdog_stale_lease',
          next_action_at=NOW(),
          lease_owner=NULL,
          lease_token=NULL,
          lease_expires_at=NULL,
          last_heartbeat_at=NULL
      WHERE id=v_job.id;
    END IF;

    SELECT msg_id INTO v_msg_id
    FROM pgmq.send(
      'core_orchestrator_v1',
      jsonb_build_object(
        'v',1,
        'job_id',v_job.id,
        'reason',CASE WHEN v_job.status='running' THEN 'stale_lease' ELSE 'watchdog' END,
        'trace_id',gen_random_uuid()
      ),
      0
    ) AS msg_id;

    UPDATE public.factory_jobs SET last_enqueued_at=NOW() WHERE id=v_job.id;
    INSERT INTO public.factory_workflow_events(job_id,event_type,dedupe_key,payload)
    VALUES(
      v_job.id,
      CASE WHEN v_job.status='running' THEN 'job.recovered' ELSE 'job.enqueued' END,
      'watchdog:enqueue:'||v_msg_id::TEXT,
      jsonb_build_object(
        'queue','core_orchestrator_v1',
        'queue_msg_id',v_msg_id,
        'previous_status',v_job.status,
        'reason',CASE WHEN v_job.status='running' THEN 'stale_lease' ELSE 'watchdog' END
      )
    );
    v_recovered:=v_recovered+1;
  END LOOP;

  RETURN jsonb_build_object('recovered',v_recovered,'stale_leases',v_stale_leases);
END;
$function$;
