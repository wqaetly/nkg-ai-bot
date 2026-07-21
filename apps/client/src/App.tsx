import { lazy, Suspense, useEffect, useState } from "react";
import { ProviderSettings } from "./ProviderSettings";
import "./App.css";

const ChatPage = lazy(() => import("./ChatPage").then((module) => ({
  default: module.ChatPage,
})));

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [settingsOpen]);

  return (
    <main className="app-shell">
      <Suspense fallback={<AppLoading />}>
        <ChatPage openProviders={() => setSettingsOpen(true)} />
      </Suspense>

      {settingsOpen ? (
        <div className="settings-layer" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section
            aria-label="模型与联网设置"
            aria-modal="true"
            className="settings-dialog"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <ProviderSettings onClose={() => setSettingsOpen(false)} />
          </section>
        </div>
      ) : null}
    </main>
  );
}

function AppLoading() {
  return (
    <div className="app-loading" role="status">
      <span className="brand-orb">N</span>
      <span>正在载入本地对话…</span>
    </div>
  );
}

export default App;
