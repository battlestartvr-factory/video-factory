export function getSidebarCollapsedSnapshot(): boolean {
  return localStorage.getItem("acf-sidebar-collapsed") === "true";
}

export function writeSidebarCollapsedSnapshot(collapsed: boolean): void {
  localStorage.setItem("acf-sidebar-collapsed", String(collapsed));
}

export function subscribeSidebarStorage(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}
