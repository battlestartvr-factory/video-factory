import "server-only";

import { isMockWorkflowsEnabled } from "@/lib/env/mock-workflows";
import { serverEnv } from "@/lib/env/env.server";
import { getFactoryWebhookCredentials } from "@/lib/factory/webhook-auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { runWf00InfrastructureCheck } from "@/lib/integrations/wf00-check";

export interface IntegrationStatus {
  configured: boolean;
  reachable: boolean;
  checked_at: string;
  message: string;
}

export interface IntegrationsStatus {
  supabase: IntegrationStatus;
  n8n: IntegrationStatus;
  googleDrive: IntegrationStatus;
  mockWorkflows: IntegrationStatus;
}

function hasSupabaseEnv(): boolean {
  return Boolean(
    serverEnv.NEXT_PUBLIC_SUPABASE_URL && serverEnv.SUPABASE_SERVICE_ROLE_KEY,
  );
}

async function checkSupabaseStatus(checkedAt: string): Promise<IntegrationStatus> {
  const configured = hasSupabaseEnv();
  if (!configured) {
    return {
      configured: false,
      reachable: false,
      checked_at: checkedAt,
      message: "Supabase env vars missing",
    };
  }

  try {
    const supabase = createSupabaseServiceClient();
    const { error } = await supabase.from("profiles").select("id").limit(1);
    if (error) {
      return {
        configured: true,
        reachable: false,
        checked_at: checkedAt,
        message: "Supabase query failed",
      };
    }
    return {
      configured: true,
      reachable: true,
      checked_at: checkedAt,
      message: "Connected",
    };
  } catch {
    return {
      configured: true,
      reachable: false,
      checked_at: checkedAt,
      message: "Supabase unreachable",
    };
  }
}

function buildN8nStatus(
  checkedAt: string,
  wf00: Awaited<ReturnType<typeof runWf00InfrastructureCheck>>,
): IntegrationStatus {
  const factoryConfigured = Boolean(getFactoryWebhookCredentials(serverEnv));

  if (isMockWorkflowsEnabled()) {
    return {
      configured: factoryConfigured,
      reachable: false,
      checked_at: checkedAt,
      message: "Mock mode — real n8n routing disabled",
    };
  }

  if (!factoryConfigured) {
    return {
      configured: false,
      reachable: false,
      checked_at: checkedAt,
      message: "n8n factory webhook not configured",
    };
  }

  if (!wf00) {
    return {
      configured: true,
      reachable: false,
      checked_at: checkedAt,
      message: "WF00 check unavailable",
    };
  }

  const reachable = wf00.ok === true && wf00.n8n?.reachable === true;
  return {
    configured: true,
    reachable,
    checked_at: checkedAt,
    message: wf00.message ?? (reachable ? "Connected" : "WF00 reported n8n unreachable"),
  };
}

function buildGoogleDriveStatus(
  checkedAt: string,
  wf00: Awaited<ReturnType<typeof runWf00InfrastructureCheck>>,
): IntegrationStatus {
  if (isMockWorkflowsEnabled()) {
    return {
      configured: false,
      reachable: false,
      checked_at: checkedAt,
      message: "Mock mode — Drive check skipped",
    };
  }

  if (!getFactoryWebhookCredentials(serverEnv)) {
    return {
      configured: false,
      reachable: false,
      checked_at: checkedAt,
      message: "WF00 not configured",
    };
  }

  if (!wf00) {
    return {
      configured: true,
      reachable: false,
      checked_at: checkedAt,
      message: "WF00 check unavailable",
    };
  }

  const reachable = wf00.ok === true && wf00.drive?.reachable === true;
  return {
    configured: true,
    reachable,
    checked_at: checkedAt,
    message: wf00.message ?? (reachable ? "Connected" : "WF00 reported Drive unreachable"),
  };
}

function buildMockWorkflowsStatus(checkedAt: string): IntegrationStatus {
  const enabled = isMockWorkflowsEnabled();
  return {
    configured: enabled,
    reachable: enabled,
    checked_at: checkedAt,
    message: enabled ? "Demo mode active" : "Production routing (real n8n)",
  };
}

export async function getIntegrationsStatus(): Promise<IntegrationsStatus> {
  const checkedAt = new Date().toISOString();
  const mockEnabled = isMockWorkflowsEnabled();
  const wf00 = mockEnabled ? null : await runWf00InfrastructureCheck();

  const [supabase] = await Promise.all([checkSupabaseStatus(checkedAt)]);

  return {
    supabase,
    n8n: buildN8nStatus(checkedAt, wf00),
    googleDrive: buildGoogleDriveStatus(checkedAt, wf00),
    mockWorkflows: buildMockWorkflowsStatus(checkedAt),
  };
}
