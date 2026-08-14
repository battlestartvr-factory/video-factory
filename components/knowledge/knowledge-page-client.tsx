"use client";

import { useState, useEffect, useRef } from "react";
import { Upload, FileText, Trash2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, Skeleton } from "@/components/ui/states";
import { SourcesCard } from "@/components/chat/sources-card";
import { getAcceptString, guessMimeFromExtension } from "@/lib/attachments/mime";
import { formatDate } from "@/lib/utils";
import { t } from "@/lib/i18n/dictionary";
import type { KnowledgeDocument } from "@/lib/types/workspace";
import type { SourceCitation } from "@/lib/types/workspace";

function formatBytes(bytes: number | null) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_LABELS: Record<string, string> = {
  pending: "Ожидание",
  uploading: "Загрузка",
  uploaded: "Загружен",
  extracting: "Извлечение текста",
  processing: "Обработка",
  ready: "Готов",
  failed: "Ошибка",
  needs_ocr: "Нужен OCR",
};

export function KnowledgePageClient() {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<SourceCitation[]>([]);
  const [asking, setAsking] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadDocuments = () => {
    fetch("/api/knowledge")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setDocuments(d.data.documents);
        setLoading(false);
      });
  };

  useEffect(() => { loadDocuments(); }, []);

  const uploadViaDrive = async (file: File, mimeType: string) => {
    const sessionRes = await fetch("/api/knowledge/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        mimeType,
        sizeBytes: file.size,
      }),
    });
    const sessionData = await sessionRes.json();
    if (!sessionData.ok) throw new Error(sessionData.error?.message ?? "Upload session failed");

    const uploadRes = await fetch(sessionData.data.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(file.size),
      },
      body: file,
    });

    if (!uploadRes.ok) throw new Error("Drive upload failed");

    const drivePayload = await uploadRes.json().catch(() => null);
    const driveFileId =
      drivePayload && typeof drivePayload === "object" && "id" in drivePayload
        ? String((drivePayload as { id: string }).id)
        : null;
    if (!driveFileId) throw new Error("Drive file id missing from upload response");

    const finalizeRes = await fetch("/api/knowledge/upload", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId: sessionData.data.documentId,
        driveFileId,
      }),
    });
    const finalizeData = await finalizeRes.json();
    if (!finalizeData.ok) throw new Error(finalizeData.error?.message ?? "Finalize failed");
    return finalizeData.data as KnowledgeDocument;
  };

  const uploadViaTextApi = async (file: File, mimeType: string, content: string) => {
    const res = await fetch("/api/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        mimeType,
        sizeBytes: file.size,
        content,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error?.message ?? "Upload failed");
    return data.data as KnowledgeDocument;
  };

  const uploadFile = async (file: File) => {
    setUploading(true);
    const mimeType = file.type || guessMimeFromExtension(file.name) || "application/octet-stream";
    try {
      const isText =
        file.type.startsWith("text/") || file.name.endsWith(".md") || file.name.endsWith(".txt");
      let doc: KnowledgeDocument;

      if (isText) {
        const content = await file.text();
        try {
          doc = await uploadViaDrive(file, mimeType);
        } catch {
          doc = await uploadViaTextApi(file, mimeType, content);
        }
      } else {
        doc = await uploadViaDrive(file, mimeType);
      }

      setDocuments((prev) => [doc, ...prev.filter((d) => d.id !== doc.id)]);
    } catch {
      // upload error — user can retry
    } finally {
      setUploading(false);
    }
  };

  const handleFiles = (files: FileList) => {
    Array.from(files).forEach(uploadFile);
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/knowledge?id=${id}`, { method: "DELETE" });
    setDocuments((prev) => prev.filter((d) => d.id !== id));
  };

  const handleAsk = async () => {
    if (!query.trim()) return;
    setAsking(true);
    const res = await fetch("/api/knowledge", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    if (data.ok) {
      setAnswer(data.data.answer);
      setSources(data.data.sources);
    }
    setAsking(false);
  };

  return (
    <div className="flex flex-1 flex-col p-4 md:p-8">
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <h1 className="text-2xl font-bold">{t("knowledge.title")}</h1>

        <div
          className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
            dragOver ? "drag-over border-accent" : "border-border"
          }`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
          }}
        >
          <Upload className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">
            Перетащите файлы или{" "}
            <button
              type="button"
              className="text-accent underline"
              onClick={() => fileInputRef.current?.click()}
            >
              выберите
            </button>
          </p>
          <p className="mt-1 text-xs text-muted">PDF, DOCX, TXT, MD — оригиналы сохраняются в Google Drive</p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={getAcceptString()}
            className="hidden"
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
          />
          {uploading && <p className="mt-2 text-xs text-accent">{t("common.loading")}</p>}
        </div>

        <Card>
          <CardContent className="pt-6">
            <div className="flex gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("knowledge.ask")}
                onKeyDown={(e) => e.key === "Enter" && handleAsk()}
              />
              <Button onClick={handleAsk} disabled={asking || !query.trim()}>
                <Search className="h-4 w-4" />
              </Button>
            </div>
            {answer && (
              <div className="mt-4 space-y-3">
                <p className="text-sm text-foreground">{answer}</p>
                {sources.length > 0 && <SourcesCard sources={sources} />}
              </div>
            )}
          </CardContent>
        </Card>

        <section>
          <h2 className="mb-3 text-lg font-semibold">{t("knowledge.documents")}</h2>
          {loading ? (
            <Skeleton className="h-20 w-full" />
          ) : documents.length === 0 ? (
            <EmptyState
              title={t("knowledge.empty")}
              description={t("knowledge.emptyDescription")}
            />
          ) : (
            <div className="space-y-2">
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 transition-colors hover:border-border"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <FileText className="h-5 w-5 shrink-0 text-accent" />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-sm">{doc.filename}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatBytes(doc.size_bytes)} · {STATUS_LABELS[doc.status] ?? doc.status} · {formatDate(doc.created_at)}
                      </p>
                    </div>
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(doc.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
