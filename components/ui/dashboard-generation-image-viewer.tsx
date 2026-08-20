"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ImageViewer } from "@/components/ui/image-viewer";

function isSupportedPath(pathname: string): boolean {
  return pathname === "/images" || pathname === "/chat" || pathname.startsWith("/chat/");
}

function isGenerationOutput(src: string): boolean {
  return src.includes("/api/generations/") && src.includes("/outputs/");
}

export function DashboardGenerationImageViewer() {
  const pathname = usePathname();
  const [selected, setSelected] = useState<{ src: string; alt: string } | null>(null);

  useEffect(() => {
    if (!isSupportedPath(pathname)) return;

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLImageElement)) return;

      const src = target.currentSrc || target.src;
      if (!src || !isGenerationOutput(src)) return;

      event.preventDefault();
      setSelected({ src, alt: target.alt || "Сгенерированное изображение" });
    };

    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [pathname]);

  return (
    <ImageViewer
      src={selected?.src ?? null}
      alt={selected?.alt}
      onClose={() => setSelected(null)}
    />
  );
}
