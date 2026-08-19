import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cardSource = readFileSync(
  new URL("../../components/chat/discovery-task-card.tsx", import.meta.url),
  "utf8",
);
const caddySource = readFileSync(new URL("../../deploy/Caddyfile", import.meta.url), "utf8");
const deploySource = readFileSync(new URL("../../scripts/deploy.sh", import.meta.url), "utf8");

describe("discovery chat prototype contract", () => {
  it("renders both completed gameplay artifacts through the authenticated same-origin stream route", () => {
    expect(cardSource).toContain('jobStatus === "completed"');
    expect(cardSource).toContain("<video");
    expect(cardSource).toContain("playsInline");
    expect(cardSource).toContain("preload=\"metadata\"");
    expect(cardSource).toContain("/api/discovery/batches/${encodeURIComponent(runId)}/prototypes/");
    expect(cardSource).toContain("Gameplay prototype готов");
    expect(cardSource).toContain("Gameplay master · 16:9");
    expect(cardSource).toContain("Social edit · 9:16");
    expect(cardSource).toContain("?variant=master");
    expect(cardSource).toContain("?variant=social");
    expect(cardSource).toContain("Скачать gameplay master 16:9");
    expect(cardSource).toContain("Скачать social edit 9:16");
  });

  it("keeps Caddy canonical and reloads tracked proxy configuration during deployment", () => {
    expect(caddySource).toContain("battlestart-factory.duckdns.org {");
    expect(caddySource).not.toContain("battlestartvr-factory.duckdns.org {");
    expect(deploySource).toContain(
      "caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile",
    );
    expect(deploySource).toContain(
      "caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile",
    );
  });
});
