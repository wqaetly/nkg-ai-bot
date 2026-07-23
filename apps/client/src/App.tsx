import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import appIcon from "../src-tauri/icons/64x64.png";
import {
  calculateLogicalViewportSize,
  DEFAULT_UI_SCALE,
  loadAppearancePreferences,
  loadThemeMode,
  resolveTheme,
  saveAppearancePreferences,
  saveThemeMode,
  stepUiScale,
  type AppearancePreferences,
  type ThemeMode,
} from "./appearance";
import { requestAppPanel, type AppPanel } from "./appPanel";
import { AppTitleBar } from "./AppTitleBar";
import { ProviderSettings } from "./ProviderSettings";
import "./App.css";

const ChatPage = lazy(() => import("./ChatPage").then((module) => ({
  default: module.ChatPage,
})));

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadThemeMode());
  const [appearance, setAppearance] = useState<AppearancePreferences>(() => loadAppearancePreferences());
  const [logicalViewport, setLogicalViewport] = useState(() => calculateLogicalViewportSize(
    window.innerWidth,
    window.innerHeight,
    appearance.uiScale,
  ));
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const resolvedTheme = useMemo(() => resolveTheme(themeMode, systemDark), [systemDark, themeMode]);
  const desktopTitleBar = !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

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
    void getCurrentWebview().setZoom(1).catch((cause: unknown) => {
      console.warn("Unable to reset native webview zoom", cause);
    });
  }, []);

  useLayoutEffect(() => {
    let frame = 0;
    const updateLogicalViewport = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setLogicalViewport(calculateLogicalViewportSize(
          window.innerWidth,
          window.innerHeight,
          appearance.uiScale,
        ));
      });
    };
    updateLogicalViewport();
    window.addEventListener("resize", updateLogicalViewport);
    window.visualViewport?.addEventListener("resize", updateLogicalViewport);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateLogicalViewport);
      window.visualViewport?.removeEventListener("resize", updateLogicalViewport);
    };
  }, [appearance.uiScale]);

  useEffect(() => {
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    const resetViewport = () => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };
    resetViewport();
    const frame = requestAnimationFrame(resetViewport);
    return () => cancelAnimationFrame(frame);
  }, [appearance.uiScale]);

  useEffect(() => {
    const hideTimers = new Map<HTMLElement, number>();
    const showScrollbarWhileScrolling = (event: Event) => {
      if (!(event.target instanceof HTMLElement)) return;
      const scroller = event.target;
      scroller.classList.add("scrollbar-active");
      const previousTimer = hideTimers.get(scroller);
      if (previousTimer !== undefined) window.clearTimeout(previousTimer);
      hideTimers.set(scroller, window.setTimeout(() => {
        scroller.classList.remove("scrollbar-active");
        hideTimers.delete(scroller);
      }, 700));
    };

    document.addEventListener("scroll", showScrollbarWhileScrolling, true);
    return () => {
      document.removeEventListener("scroll", showScrollbarWhileScrolling, true);
      hideTimers.forEach((timer, scroller) => {
        window.clearTimeout(timer);
        scroller.classList.remove("scrollbar-active");
      });
      hideTimers.clear();
    };
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [settingsOpen]);

  useEffect(() => {
    const handleZoomShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      let uiScale: number | undefined;
      if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") {
        uiScale = stepUiScale(appearance.uiScale, 1);
      } else if (event.key === "-" || event.code === "NumpadSubtract") {
        uiScale = stepUiScale(appearance.uiScale, -1);
      } else if (event.key === "0" || event.code === "Numpad0") {
        uiScale = DEFAULT_UI_SCALE;
      }
      if (uiScale === undefined) return;
      event.preventDefault();
      const next = { ...appearance, uiScale };
      if (saveAppearancePreferences(next, appearance)) setAppearance(next);
    };
    window.addEventListener("keydown", handleZoomShortcut, true);
    return () => window.removeEventListener("keydown", handleZoomShortcut, true);
  }, [appearance]);

  function updateAppearance(next: AppearancePreferences): boolean {
    if (!saveAppearancePreferences(next, appearance)) return false;
    setAppearance(next);
    return true;
  }

  function openTool(panel: AppPanel) {
    setSettingsOpen(false);
    requestAppPanel(panel);
  }

  return (
    <main
      className={`app-shell ${desktopTitleBar ? "desktop-shell" : "mobile-shell"}${appearance.backgroundImage ? " has-custom-background" : ""}`}
      style={{
        width: logicalViewport.width,
        height: logicalViewport.height,
        transform: `scale(${appearance.uiScale})`,
        transformOrigin: "0 0",
      }}
    >
      {desktopTitleBar ? <AppTitleBar /> : null}
      <div
        aria-hidden="true"
        className="app-background-image"
        style={appearance.backgroundImage ? {
          backgroundImage: `url("${appearance.backgroundImage}")`,
          opacity: appearance.backgroundOpacity,
        } : undefined}
      />
      <Suspense fallback={<AppLoading />}>
        <ChatPage
          openProviders={() => setSettingsOpen(true)}
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
            <ProviderSettings
              appearance={appearance}
              themeMode={themeMode}
              onAppearanceChange={updateAppearance}
              onClose={() => setSettingsOpen(false)}
              onOpenTool={openTool}
              onThemeModeChange={setThemeMode}
            />
          </section>
        </div>
      ) : null}
    </main>
  );
}

function AppLoading() {
  return (
    <div className="app-loading" role="status">
      <img alt="" aria-hidden="true" className="app-loading-icon" src={appIcon} />
      <span>正在载入本地对话…</span>
    </div>
  );
}

export default App;
