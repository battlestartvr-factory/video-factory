"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ImageViewer } from "@/components/ui/image-viewer";

function isSupportedPath(pathname: string): boolean {
  return (
    pathname === "/images" ||
    pathname === "/chat" ||
    pathname.startsWith("/chat/") ||
    pathname === "/discovery" ||
    pathname.startsWith("/discovery/")
  );
}

function isGenerationOutput(src: string): boolean {
  return src.includes("/api/generations/") && src.includes("/outputs/");
}

function isViewerImage(image: HTMLImageElement, pathname: string): boolean {
  const src = image.currentSrc || image.src;
  if (!src) return false;

  if (pathname === "/images" || pathname === "/chat" || pathname.startsWith("/chat/")) {
    return isGenerationOutput(src);
  }

  if (pathname === "/discovery" || pathname.startsWith("/discovery/")) {
    return image.alt.startsWith("Gameplay reference ");
  }

  return false;
}

export function DashboardGenerationImageViewer() {
  const pathname = usePathname();
  const [selected, setSelected] = useState<{ src: string; alt: string } | null>(null);

  useEffect(() => {
    if (!isSupportedPath(pathname)) return;

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLImageElement) || !isViewerImage(target, pathname)) return;

      const src = target.currentSrc || target.src;
      event.preventDefault();
      setSelected({ src, alt: target.alt || "Сгенерированное изображение" });
    };

    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [pathname]);

  return (
    <>
      <style>{`
        img[src*="/api/generations/"][src*="/outputs/"],
        img[alt^="Gameplay reference "] {
          cursor: zoom-in;
        }
      `}</style>
      <ImageViewer
        src={selected?.src ?? null}
        alt={selected?.alt}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
