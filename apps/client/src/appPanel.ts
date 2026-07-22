export type AppPanel = "memory" | "skills" | "evaluation" | "image-studio";

const OPEN_APP_PANEL_EVENT = "nkg:open-app-panel";

export function requestAppPanel(panel: AppPanel): void {
  window.dispatchEvent(new CustomEvent<AppPanel>(OPEN_APP_PANEL_EVENT, { detail: panel }));
}

export function subscribeAppPanel(listener: (panel: AppPanel) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<AppPanel>).detail);
  window.addEventListener(OPEN_APP_PANEL_EVENT, handle);
  return () => window.removeEventListener(OPEN_APP_PANEL_EVENT, handle);
}
