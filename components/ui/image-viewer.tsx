"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface ImageViewerProps {
  src: string | null;
  alt?: string;
  onClose: () => void;
}

export function ImageViewer({ src, alt = "Изображение", onClose }: ImageViewerProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!src) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [src, onClose]);

  if (!mounted || !src) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр изображения"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/95 p-3 sm:p-6"
      onClick={onClose}
    >
      <button
        type="button"
        aria-label="Закрыть просмотр"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="absolute right-3 top-3 z-10 grid h-11 w-11 place-items-center rounded-full border border-white/20 bg-black/70 text-white backdrop-blur transition hover:bg-black/90 sm:right-5 sm:top-5"
      >
        <X className="h-5 w-5" />
      </button>

      <div
        className="flex max-h-full max-w-full items-center justify-center"
        onClick={(event) => event.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="max-h-[calc(100vh-1.5rem)] max-w-[calc(100vw-1.5rem)] select-none object-contain sm:max-h-[calc(100vh-3rem)] sm:max-w-[calc(100vw-3rem)]"
        />
      </div>
    </div>,
    document.body,
  );
}
