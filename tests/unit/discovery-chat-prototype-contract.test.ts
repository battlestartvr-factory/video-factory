import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cardSource = readFileSync(
  new URL("../../components/chat/discovery-task-card.tsx", import.meta.url),
  "utf8",
);
const caddySource = readFileSync(new URL("../../deploy/Caddyfile", import.meta.url), "utf8");

describe("discovery chat prototype contract", () => {
  it("renders completed prototype video through the authenticated same-origin stream route", () => {
    expect(cardSource).toContain('jobStatus === "completed"');
    expect(cardSource).toContain("<video");
    expect(cardSource).toContain("playsInline");
    expect(cardSource).toContain("preload=\"metadata\"");
    expect(cardSource).toContain("/api/discovery/batches/${encodeURIComponent(runId)}/prototypes/");
    expect(cardSource).toContain("Prototype video готов");
  });

  it("keeps the legacy vr hostname from becoming a dead-end", () => {
    expect(caddySource).toContain("battlestartvr-factory.duckdns.org {");
    expect(caddySource).toContain(
      "redir https://battlestart-factory.duckdns.org{uri} permanent",
    );
  });
});
