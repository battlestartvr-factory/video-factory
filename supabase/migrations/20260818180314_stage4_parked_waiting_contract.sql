-- Stage 4 intentionally parks durable jobs with waiting + next_action_at NULL while
-- human reference approval is required. Retrying must always keep a timer, but a
-- waiting job without a timer is valid and is resumed by an explicit wake-up.

CREATE OR REPLACE FUNCTION public.orchestrator_finish_tick(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_new_status text,
  p_state jsonb DEFAULT NULL::jsonb,
  p_current_stage text DEFAULT NULL::text,
  p_progress smallint DEFAULT NULL::smallint,
  p_next_action_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_result jsonb DEFAULT NULL::jsonb,
  p_error jsonb DEFAULT NULL::jsonb,
  p_state_reason text DEFAULT NULL::text,
  p_event_type text DEFAULT 'job.transitioned'::text,
  p_event_payload jsonb DEFAULT '{}'::jsonb,
  p_creative_run_id uuid DEFAULT NULL::uuid,
  p_enqueue_reason text DEFAULT NULL::text,
  p_trace_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pgmq'
AS $function$
DECLARE
  v_job RECORD;
  v_delay_seconds INTEGER := 0;
  v_msg_id BIGINT;
  v_trace_id UUID := COALESCE(p_trace_id,gen_random_uuid());
  v_enqueue_reason TEXT;
  v_effective_next_action TIMESTAMPTZ;
  v_retry_count INTEGER;
BEGIN
  SELECT status,lease_owner,lease_token,lease_expires_at,retry_count
    INTO v_job
  FROM public.factory_jobs
  WHERE id=p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'reason','job_not_found'); END IF;
  IF v_job.status<>'running' OR v_job.lease_owner IS DISTINCT FROM p_worker_id OR v_job.lease_token IS DISTINCT FROM p_lease_token THEN
    RETURN jsonb_build_object('success',false,'reason','lease_mismatch');
  END IF;
  IF v_job.lease_expires_at IS NULL OR v_job.lease_expires_at<=NOW() THEN
    RETURN jsonb_build_object('success',false,'reason','lease_expired');
  END IF;
  IF p_new_status NOT IN ('queued','waiting','retrying','awaiting_approval','completed','failed','cancelled') THEN
    RAISE EXCEPTION 'invalid running transition target: %',p_new_status;
  END IF;
  IF p_progress IS NOT NULL AND (p_progress<0 OR p_progress>100) THEN
    RAISE EXCEPTION 'progress must be between 0 and 100';
  END IF;

  IF p_new_status='retrying' AND p_next_action_at IS NULL THEN
    RAISE EXCEPTION 'retrying requires next_action_at for durable recovery';
  END IF;

  IF p_new_status='queued' THEN
    v_effective_next_action:=NOW();
    v_enqueue_reason:=COALESCE(NULLIF(trim(p_enqueue_reason),''),'next_stage');
  ELSIF p_new_status IN ('waiting','retrying') THEN
    v_effective_next_action:=p_next_action_at;
    IF p_next_action_at IS NOT NULL THEN
      v_delay_seconds:=GREATEST(0,CEIL(EXTRACT(EPOCH FROM (p_next_action_at-NOW())))::INTEGER);
      v_enqueue_reason:=COALESCE(NULLIF(trim(p_enqueue_reason),''),CASE WHEN p_new_status='retrying' THEN 'retry' ELSE 'reconcile' END);
    ELSE
      v_enqueue_reason:=NULL;
    END IF;
  ELSE
    v_effective_next_action:=NULL;
  END IF;

  v_retry_count:=v_job.retry_count+CASE WHEN p_new_status='retrying' THEN 1 ELSE 0 END;

  UPDATE public.factory_jobs
  SET status=p_new_status,
      current_stage=COALESCE(p_current_stage,current_stage),
      progress=COALESCE(p_progress,progress),
      state=COALESCE(p_state,state),
      result=COALESCE(p_result,result),
      error=p_error,
      retry_count=v_retry_count,
      state_reason=p_state_reason,
      next_action_at=v_effective_next_action,
      completed_at=CASE WHEN p_new_status IN ('completed','failed','cancelled') THEN COALESCE(completed_at,NOW()) ELSE NULL END,
      lease_owner=NULL,
      lease_token=NULL,
      lease_expires_at=NULL,
      last_heartbeat_at=NULL
  WHERE id=p_job_id;

  INSERT INTO public.factory_workflow_events(job_id,creative_run_id,event_type,dedupe_key,payload)
  VALUES(
    p_job_id,
    p_creative_run_id,
    COALESCE(NULLIF(trim(p_event_type),''),'job.transitioned'),
    'job:transition:'||p_job_id::TEXT||':'||p_lease_token::TEXT,
    COALESCE(p_event_payload,'{}'::JSONB)||jsonb_build_object('from_status','running','to_status',p_new_status,'worker_id',p_worker_id,'retry_count',v_retry_count)
  );

  IF p_new_status='queued' OR (p_new_status IN ('waiting','retrying') AND v_effective_next_action IS NOT NULL) THEN
    SELECT msg_id INTO v_msg_id
    FROM pgmq.send(
      'core_orchestrator_v1',
      jsonb_build_object('v',1,'job_id',p_job_id,'reason',v_enqueue_reason,'trace_id',v_trace_id),
      v_delay_seconds
    ) AS msg_id;
    UPDATE public.factory_jobs SET last_enqueued_at=NOW() WHERE id=p_job_id;
    INSERT INTO public.factory_workflow_events(job_id,creative_run_id,event_type,dedupe_key,payload)
    VALUES(
      p_job_id,
      p_creative_run_id,
      'job.enqueued',
      'queue:enqueued:'||v_msg_id::TEXT,
      jsonb_build_object('queue','core_orchestrator_v1','queue_msg_id',v_msg_id,'reason',v_enqueue_reason,'delay_seconds',v_delay_seconds,'trace_id',v_trace_id)
    );
  END IF;

  RETURN jsonb_build_object(
    'success',true,
    'status',p_new_status,
    'retry_count',v_retry_count,
    'queue_msg_id',v_msg_id,
    'next_action_at',v_effective_next_action,
    'trace_id',CASE WHEN v_msg_id IS NULL THEN NULL ELSE v_trace_id END
  );
END;
$function$;
