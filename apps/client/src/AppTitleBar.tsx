import { useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import appIcon from "../src-tauri/icons/64x64.png";

export function AppTitleBar() {
  const appWindow = useMemo(() => getCurrentWindow(), []);

  const runWindowAction = (action: () => Promise<unknown>) => {
    void action().catch((cause: unknown) => {
      console.warn("Unable to update desktop window", cause);
    });
  };

  return (
    <header
      aria-label="应用窗口标题栏"
      className="app-titlebar"
      data-tauri-drag-region
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        runWindowAction(() => appWindow.toggleMaximize());
      }}
    >
      <div className="app-titlebar-brand" data-tauri-drag-region>
        <img alt="" aria-hidden="true" src={appIcon} />
        <strong data-tauri-drag-region>NKG AI Bot</strong>
      </div>
      <div className="app-window-controls">
        <button aria-label="最小化窗口" title="最小化" type="button" onClick={() => runWindowAction(() => appWindow.minimize())}>
          <MinimizeIcon />
        </button>
        <button aria-label="最大化或还原窗口" title="最大化或还原" type="button" onClick={() => runWindowAction(() => appWindow.toggleMaximize())}>
          <MaximizeIcon />
        </button>
        <button aria-label="关闭窗口" className="close" title="关闭" type="button" onClick={() => runWindowAction(() => appWindow.close())}>
          <CloseIcon />
        </button>
      </div>
    </header>
  );
}

function WindowIcon({ children }: { children: React.ReactNode }) {
  return <svg aria-hidden="true" viewBox="0 0 12 12">{children}</svg>;
}

function MinimizeIcon() {
  return <WindowIcon><path d="M2 6.5h8" /></WindowIcon>;
}

function MaximizeIcon() {
  return <WindowIcon><rect height="7" width="7" x="2.5" y="2.5" /></WindowIcon>;
}

function CloseIcon() {
  return <WindowIcon><path d="m2.5 2.5 7 7m0-7-7 7" /></WindowIcon>;
}
