"use client";

import { useRef, useState } from "react";
import { FileImage, Film, Loader2, Plus, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface GeneratorVisualAsset {
  id: string;
  url: string;
  storagePath?: string;
  mimeType: string;
  filename: string;
  sizeBytes?: number;
  category?: "image" | "video";
  role?: string;
}

interface GeneratorAssetPickerProps {
  label: string;
  hint?: string;
  value: GeneratorVisualAsset[];
  onChange: (assets: GeneratorVisualAsset[]) => void;
  maxFiles?: number;
  accept?: "image" | "video" | "both";
  disabled?: boolean;
  compact?: boolean;
}

function acceptString(accept: GeneratorAssetPickerProps["accept"]): string {
  if (accept === "video") return "video/mp4,video/quicktime,video/webm";
  if (accept === "both") {
    return "image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm";
  }
  return "image/png,image/jpeg,image/webp";
}

function fileMatches(file: File, accept: GeneratorAssetPickerProps["accept"]): boolean {
  if (accept === "video") return file.type.startsWith("video/");
  if (accept === "both") return file.type.startsWith("image/") || file.type.startsWith("video/");
  return file.type.startsWith("image/");
}

export function GeneratorAssetPicker({
  label,
  hint,
  value,
  onChange,
  maxFiles = 1,
  accept = "image",
  disabled,
  compact,
}: GeneratorAssetPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploadFiles = async (files: FileList | File[]) => {
    const remaining = Math.max(0, maxFiles - value.length);
    const selected = Array.from(files).filter((file) => fileMatches(file, accept)).slice(0, remaining);
    if (!selected.length) return;

    setUploading(true);
    setError(null);
    try {
      const uploaded: GeneratorVisualAsset[] = [];
      for (const file of selected) {
        const body = new FormData();
        body.append("file", file);
        const response = await fetch("/api/generator-assets", { method: "POST", body });
        const payload = await response.json();
        if (!response.ok || !payload.ok || payload.data?.kind !== "asset") {
          throw new Error(payload?.error?.message ?? "Не удалось загрузить файл");
        }
        uploaded.push(payload.data.asset as GeneratorVisualAsset);
      }
      onChange([...value, ...uploaded].slice(0, maxFiles));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Не удалось загрузить файл");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const removeAsset = (asset: GeneratorVisualAsset) => {
    onChange(value.filter((item) => item.id !== asset.id));
    if (asset.storagePath) {
      void fetch("/api/generator-assets", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storagePath: asset.storagePath }),
      });
    }
  };

  const canAdd = value.length < maxFiles && !disabled;

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">{label}</p>
          {hint ? <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{hint}</p> : null}
        </div>
        {maxFiles > 1 ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">{value.length}/{maxFiles}</span>
        ) : null}
      </div>

      {value.length > 0 ? (
        <div className={cn("grid gap-2", compact ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-3")}>
          {value.map((asset) => {
            const isVideo = asset.mimeType.startsWith("video/");
            return (
              <div
                key={asset.id}
                className="group relative aspect-square overflow-hidden rounded-xl border border-border bg-black/20"
              >
                {isVideo ? (
                  <video src={asset.url} muted playsInline className="h-full w-full object-cover" />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={asset.url} alt={asset.filename} className="h-full w-full object-cover" />
                )}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-6">
                  <p className="truncate text-[10px] text-white/90">{asset.filename}</p>
                </div>
                <button
                  type="button"
                  aria-label={`Удалить ${asset.filename}`}
                  onClick={() => removeAsset(asset)}
                  className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-black/65 text-white opacity-90 transition hover:bg-black"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
          {canAdd ? (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="grid aspect-square place-items-center rounded-xl border border-dashed border-border bg-surface-elevated/50 text-muted-foreground transition hover:border-accent/60 hover:text-foreground"
            >
              <Plus className="h-5 w-5" />
            </button>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          disabled={!canAdd || uploading}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            if (!canAdd) return;
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            if (!canAdd) return;
            event.preventDefault();
            setDragOver(false);
            if (event.dataTransfer.files.length) void uploadFiles(event.dataTransfer.files);
          }}
          className={cn(
            "flex w-full items-center gap-3 rounded-xl border border-dashed border-border bg-surface-elevated/40 p-4 text-left transition",
            "hover:border-accent/60 hover:bg-surface-elevated disabled:cursor-not-allowed disabled:opacity-50",
            dragOver && "border-accent bg-accent-muted/30",
          )}
        >
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface text-muted-foreground">
            {uploading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : accept === "video" ? (
              <Film className="h-5 w-5" />
            ) : accept === "both" ? (
              <Upload className="h-5 w-5" />
            ) : (
              <FileImage className="h-5 w-5" />
            )}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {uploading ? "Загрузка…" : "Перетащите файл или выберите"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {accept === "video" ? "MP4, MOV, WebM" : accept === "both" ? "Изображение или видео" : "PNG, JPG, WebP"}
            </p>
          </div>
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple={maxFiles > 1}
        accept={acceptString(accept)}
        className="hidden"
        disabled={disabled || uploading}
        onChange={(event) => event.target.files && void uploadFiles(event.target.files)}
      />
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}

export function AddGeneratorAssetButton({
  onClick,
  disabled,
  label = "Добавить референс",
}: {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick} disabled={disabled}>
      <Plus className="h-3.5 w-3.5" />
      {label}
    </Button>
  );
}
