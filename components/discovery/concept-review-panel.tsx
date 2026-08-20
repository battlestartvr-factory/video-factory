"use client";

import { Check, RotateCcw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type ConceptReviewDecision = "approve" | "revise" | "reject";

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function decisionLabel(decision: unknown): string {
  if (decision === "approve") return "Идея утверждена";
  if (decision === "revise") return "Нужна правка идеи";
  if (decision === "reject") return "Идея отклонена";
  return "Ждёт решения";
}

function Section({ title, value }: { title: string; value: unknown }) {
  const text = str(value);
  if (!text) return null;
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</p>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{text}</p>
    </div>
  );
}

export function ConceptReviewPanel({
  concept,
  review,
  feedback,
  onFeedback,
  onDecision,
  disabled,
  gateActive,
}: {
  concept: Record<string, unknown>;
  review: Record<string, unknown> | null;
  feedback: string;
  onFeedback: (value: string) => void;
  onDecision: (decision: ConceptReviewDecision) => void;
  disabled: boolean;
  gateActive: boolean;
}) {
  const buildability = object(concept.buildability);
  const playerRoles = array(concept.playerRoles).map(object);
  const noveltyAxes = array(concept.noveltyAxes).map(object);
  const interactionModel = array(concept.interactionModel).map(String);
  const decision = review?.decision;

  return (
    <div className="space-y-4 border-b border-border bg-background/10 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Human Concept Gate</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Сначала утвердите саму игру. До этого gameplay-моменты, картинки и видео не запускаются.
          </p>
        </div>
        <Badge
          variant={
            decision === "approve"
              ? "success"
              : decision === "reject"
                ? "danger"
                : decision === "revise"
                  ? "warning"
                  : "secondary"
          }
        >
          {decisionLabel(decision)}
        </Badge>
      </div>

      <div className="grid gap-4 rounded-xl border border-border bg-background/30 p-4 md:grid-cols-2">
        <Section title="Core mechanic" value={concept.coreMechanic} />
        <Section title="Почему нужен co-op" value={concept.coopDependency} />
        <Section title="Gameplay hook" value={concept.gameplayHook} />
        <Section title="Failure / tension" value={concept.failureMode} />
        <Section title="Social moment" value={concept.socialMoment} />
        <Section title="Spectacle" value={concept.spectacle} />
        <Section title="Setting" value={concept.setting} />
        <Section title="Art direction" value={concept.artDirection} />
        <Section title="Camera" value={concept.camera} />
        <Section title="Readability" value={concept.readability} />

        {interactionModel.length > 0 && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Interaction model</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {interactionModel.map((item) => (
                <Badge key={item} variant="secondary">{item}</Badge>
              ))}
            </div>
          </div>
        )}

        {playerRoles.length > 0 && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Роли игроков</p>
            <ul className="mt-1 space-y-1.5 text-sm text-muted-foreground">
              {playerRoles.map((role, index) => (
                <li key={`${str(role.role) ?? "role"}-${index}`}>
                  <span className="font-medium text-foreground">{str(role.role) ?? `Игрок ${index + 1}`}:</span>{" "}
                  {str(role.responsibility) ?? "—"}
                </li>
              ))}
            </ul>
          </div>
        )}

        {noveltyAxes.length > 0 && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Что здесь нового</p>
            <ul className="mt-1 space-y-1.5 text-sm text-muted-foreground">
              {noveltyAxes.slice(0, 5).map((axis, index) => (
                <li key={`${str(axis.axis) ?? "axis"}-${index}`}>
                  <span className="font-medium text-foreground">{str(axis.axis) ?? "Ось"}:</span>{" "}
                  {str(axis.choice) ?? "—"}
                </li>
              ))}
            </ul>
          </div>
        )}

        {Object.keys(buildability).length > 0 && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Buildability</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              networking: {str(buildability.networking) ?? "—"}; physics: {str(buildability.physics) ?? "—"}; content: {str(buildability.contentBurden) ?? "—"}; NPC AI: {str(buildability.npcAiDependency) ?? "—"}.
            </p>
            {array(buildability.mainRisks).length > 0 && (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Риски: {array(buildability.mainRisks).map(String).join("; ")}
              </p>
            )}
          </div>
        )}
      </div>

      <textarea
        value={feedback}
        onChange={(event) => onFeedback(event.target.value)}
        placeholder="Что нравится или что нужно поменять в механике, co-op, геймдизайне, сеттинге или арте? Для Исправить / Отклонить комментарий обязателен."
        disabled={!gateActive}
        className="min-h-28 w-full resize-y rounded-lg border border-border bg-background/60 px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
      />

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onDecision("approve")} disabled={disabled || !gateActive}>
          <Check className="h-4 w-4" /> Утвердить идею
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onDecision("revise")} disabled={disabled || !gateActive}>
          <RotateCcw className="h-4 w-4" /> Исправить идею
        </Button>
        <Button size="sm" variant="danger" onClick={() => onDecision("reject")} disabled={disabled || !gateActive}>
          <X className="h-4 w-4" /> Отклонить и заменить
        </Button>
      </div>

      {decision === "reject" && (
        <p className="text-xs leading-5 text-muted-foreground">
          При отклонении эта идея удаляется из активного набора. Завод обязан создать механически новую игру, а не рескин старой; отклонённая версия остаётся только как negative memory.
        </p>
      )}
    </div>
  );
}
