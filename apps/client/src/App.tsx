import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  loadThemeMode,
  nextThemeMode,
  resolveTheme,
  saveThemeMode,
  type ThemeMode,
} from "./appearance";
import { ProviderSettings } from "./ProviderSettings";
import "./App.css";

const ChatPage = lazy(() => import("./ChatPage").then((module) => ({
  default: module.ChatPage,
})));

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadThemeMode());
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const resolvedTheme = useMemo(() => resolveTheme(themeMode, systemDark), [systemDark, themeMode]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
    saveThemeMode(themeMode);
  }, [resolvedTheme, themeMode]);

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
        <ChatPage
          openProviders={() => setSettingsOpen(true)}
          themeMode={themeMode}
          toggleTheme={() => setThemeMode((current) => nextThemeMode(current))}
        />
      </Suspense>

      {settingsOpen ? (
        <div className="settings-layer" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section
            aria-label="应用设置"
            aria-modal="true"
            className="settings-dialog provider-settings-dialog"
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
