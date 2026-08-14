"use client";

import { useCallback, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n/dictionary";

interface ContextLayer {
  id: string;
  title: string;
  source: string;
  present: boolean;
  editable: boolean;
  charCount: number;
  itemCount?: number;
  text?: string;
}

interface ContextPreviewResponse {
  manifest: Record<string, unknown>;
  layers: ContextLayer[];
  instructionsCharCount: number;
  recentMessagesCount: number;
  currentUserMessageChars: number;
  turnTools?: {
    intent: string;
    count: number;
    names: string[];
  };
}

interface ContextInspectorProps {
  chatId: string;
  modelId?: string;
  presetId?: string;
  draftContent?: string;
}

export function ContextInspector({ chatId, modelId, presetId, draftContent }: ContextInspectorProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ContextPreviewResponse | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const loadPreview = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (modelId) params.set("modelId", modelId);
      if (presetId) params.set("presetId", presetId);
      if (draftContent?.trim()) params.set("content", draftContent.trim());
      const res = await fetch(`/api/chats/${chatId}/context-preview?${params.toString()}`);
      const json = await res.json();
      if (json.ok) setData(json.data as ContextPreviewResponse);
    } finally {
      setLoading(false);
    }
  }, [chatId, modelId, presetId, draftContent]);

  const openInspector = () => {
    setOpen(true);
    void loadPreview();
  };

  const toggleLayer = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <>
      <Button variant="ghost" size="sm" type="button" onClick={openInspector}>
        {t("chat.context")}
      </Button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 md:items-center">
          <div
            role="dialog"
            aria-labelledby="context-inspector-title"
            className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-surface shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 id="context-inspector-title" className="text-sm font-semibold">
                {t("chat.contextTitle")}
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1 text-muted-foreground hover:text-foreground"
                aria-label="Закрыть"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {loading ? (
                <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
              ) : data ? (
                <>
                  {data.turnTools ? (
                    <div className="mb-4 rounded-lg border border-border-subtle bg-surface-hover/40 px-3 py-2">
                      <p className="text-sm font-medium">Инструменты этого запроса</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {data.turnTools.count === 0
                          ? "0 инструментов"
                          : `${data.turnTools.count} инструмент${data.turnTools.count === 1 ? "" : data.turnTools.count < 5 ? "а" : "ов"}`}
                      </p>
                      {data.turnTools.names.length > 0 ? (
                        <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                          {data.turnTools.names.map((name) => (
                            <li key={name}>{name}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                  <ul className="space-y-2">
                  {data.layers.map((layer) => {
                    const canExpand = layer.present && layer.text && layer.id !== "runtimePolicy";
                    const isExpanded = expanded[layer.id];
                    return (
                      <li key={layer.id} className="rounded-lg border border-border-subtle bg-surface-hover/40">
                        <button
                          type="button"
                          className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm"
                          onClick={() => (canExpand || layer.id === "runtimePolicy" ? toggleLayer(layer.id) : undefined)}
                          disabled={!layer.text}
                        >
                          {(canExpand || layer.id === "runtimePolicy") && layer.text ? (
                            isExpanded ? (
                              <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                            )
                          ) : (
                            <span className="w-4 shrink-0" />
                          )}
                          <span className="flex-1">
                            <span className="font-medium">{layer.title}</span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              {layer.present ? "✓" : "—"} {layer.source}
                              {layer.itemCount != null ? ` · ${layer.itemCount} записей` : ""}
                              {layer.charCount > 0 ? ` · ${layer.charCount.toLocaleString("ru-RU")} символов` : ""}
                            </span>
                          </span>
                        </button>
                        {isExpanded && layer.text ? (
                          <pre className="max-h-48 overflow-auto whitespace-pre-wrap border-t border-border-subtle px-3 py-2 text-xs text-muted-foreground">
                            {layer.text}
                          </pre>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{t("common.error")}</p>
              )}
            </div>

            <div className="border-t border-border px-4 py-3">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
