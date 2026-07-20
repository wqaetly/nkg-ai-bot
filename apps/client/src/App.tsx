import { useEffect, useState } from "react";
import type { AppPlatform, RuntimeBackendKind } from "@nkg-ai-bot/runtime-router";
import { getRuntimeServices } from "./runtime";
import { ProviderSettings } from "./ProviderSettings";
import type { RuntimeCatalogFailure } from "./runtimeCatalog";
import type { MobileRuntimeLifecycleState } from "./mobileRuntimeLifecycle";
import { ChatPage } from "./ChatPage";
import "./App.css";

type BootState =
  | { phase: "starting" }
  | {
      phase: "ready" | "degraded";
      platform: AppPlatform;
      backend: RuntimeBackendKind;
      registeredFlows: number;
      totalFlows: number;
      catalogFailures: RuntimeCatalogFailure[];
      lifecycle: Exclude<MobileRuntimeLifecycleState["phase"], "failed">;
    }
  | { phase: "failed"; message: string };

function App() {
  const [boot, setBoot] = useState<BootState>({ phase: "starting" });
  const [view, setView] = useState<"runtime" | "chat" | "providers">("runtime");

  useEffect(() => {
    let active = true;
    let unsubscribeLifecycle: (() => void) | undefined;

    void getRuntimeServices()
      .then(({ services, platform, lifecycle }) => {
        if (!active) return;
        unsubscribeLifecycle = lifecycle.subscribe((state) => {
          if (!active) return;
          if (state.phase === "failed") {
            setBoot({ phase: "failed", message: state.message });
            return;
          }
          setBoot({
            phase: state.catalog.failures.length === 0 ? "ready" : "degraded",
            platform,
            backend: services.router.backendKind,
            registeredFlows: state.catalog.registered,
            totalFlows: state.catalog.total,
            catalogFailures: state.catalog.failures,
            lifecycle: state.phase,
          });
        });
      })
      .catch((error: unknown) => {
        if (active) {
          setBoot({
            phase: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      active = false;
      unsubscribeLifecycle?.();
    };
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">N</span>
          <div>
            <strong>NKG AI Bot</strong>
            <small>Local-first runtime</small>
          </div>
        </div>

        <nav aria-label="主导航">
          <button className={`nav-item ${view === "runtime" ? "active" : ""}`} type="button" onClick={() => setView("runtime")}>
            <span>✦</span> 运行时
          </button>
          <button className={`nav-item ${view === "chat" ? "active" : ""}`} type="button" onClick={() => setView("chat")}>
            <span>◌</span> 对话
          </button>
          <button className="nav-item" type="button" disabled>
            <span>◇</span> 角色
          </button>
          <button className="nav-item" type="button" disabled>
            <span>⌘</span> 助理
          </button>
          <button className={`nav-item ${view === "providers" ? "active" : ""}`} type="button" onClick={() => setView("providers")}>
            <span>⚙</span> 模型服务
          </button>
        </nav>

        <div className="privacy-note">
          <span className="privacy-dot" />
          数据仅保留在本机
        </div>
      </aside>

      <main className="workspace">
        {view === "providers"
          ? <ProviderSettings />
          : view === "chat"
            ? <ChatPage openProviders={() => setView("providers")} />
            : <RuntimePage boot={boot} />}
      </main>
    </div>
  );
}

function RuntimePage({ boot }: { boot: BootState }) {
  const status = runtimeStatusLabel(boot);
  return (
    <>
        <header>
          <div>
            <p className="eyebrow">CROSS-PLATFORM FOUNDATION</p>
            <h1>运行时基座</h1>
          </div>
          <span className={`status-pill ${status.className}`}>
            <span />
            {status.label}
          </span>
        </header>

        <section className="hero-card">
          <div>
            <p className="section-label">当前里程碑</p>
            <h2>同一套 Flow API，按平台选择执行引擎</h2>
            <p className="hero-copy">
              桌面端由 Rust 托管 Node sidecar；Android 与 iOS 使用进程内 Runtime。
              UI 和业务层无需感知底层差异。
            </p>
          </div>
          <div className="route-map" aria-label="运行时路由示意">
            <div className="route-node primary">统一 Runtime Router</div>
            <div className="route-lines"><i /><i /></div>
            <div className="route-targets">
              <div><b>Desktop</b><span>Node sidecar</span></div>
              <div><b>Mobile</b><span>In-process</span></div>
            </div>
          </div>
        </section>

        <section className="runtime-grid">
          <article>
            <p className="section-label">启动状态</p>
            <RuntimeStatus boot={boot} />
          </article>
          <article>
            <p className="section-label">安全边界</p>
            <SecurityBoundary boot={boot} />
          </article>
        </section>
    </>
  );
}

function RuntimeStatus({ boot }: { boot: BootState }) {
  if (boot.phase === "failed") {
    return <p className="error-message">{boot.message}</p>;
  }
  if (boot.phase === "starting") {
    return <div className="loading-line"><span /> 正在等待原生宿主完成握手…</div>;
  }
  return (
    <dl className="runtime-details">
      <div><dt>平台</dt><dd>{boot.platform}</dd></div>
      <div><dt>执行后端</dt><dd>{boot.backend}</dd></div>
      <div><dt>生命周期</dt><dd>{lifecycleLabel(boot.lifecycle)}</dd></div>
      <div><dt>本地 Flow</dt><dd>{boot.registeredFlows} / {boot.totalFlows}</dd></div>
      {boot.catalogFailures.length === 0 ? null : (
        <div className="catalog-warning">
          <dt>同步警告</dt>
          <dd>{boot.catalogFailures.map((failure) => `${failure.name}: ${failure.message}`).join("；")}</dd>
        </div>
      )}
    </dl>
  );
}

function runtimeStatusLabel(boot: BootState): { className: string; label: string } {
  if (boot.phase === "starting") return { className: "starting", label: "正在启动" };
  if (boot.phase === "failed") return { className: "failed", label: "启动或恢复失败" };
  if (boot.lifecycle === "suspended" || boot.lifecycle === "suspending") {
    return { className: "suspended", label: "已挂起" };
  }
  if (boot.lifecycle === "resuming") return { className: "resuming", label: "正在恢复" };
  return boot.phase === "degraded"
    ? { className: "degraded", label: "部分可用" }
    : { className: "ready", label: "运行中" };
}

function lifecycleLabel(phase: Exclude<MobileRuntimeLifecycleState["phase"], "failed">): string {
  switch (phase) {
    case "active": return "前台运行";
    case "degraded": return "前台运行（目录降级）";
    case "suspending": return "正在挂起";
    case "suspended": return "后台挂起";
    case "resuming": return "正在恢复";
  }
}

function SecurityBoundary({ boot }: { boot: BootState }) {
  const isMobile = boot.phase === "ready" || boot.phase === "degraded"
    ? boot.platform === "android" || boot.platform === "ios"
    : false;

  return (
    <ul className="check-list">
      {isMobile ? (
        <>
          <li>Flow 在应用进程内执行，不开放本地端口</li>
          <li>模型请求通过原生 HTTP 能力发出</li>
          <li>API Key 加密保存在 Stronghold</li>
          <li>前端不开放通用 Shell 权限</li>
        </>
      ) : (
        <>
          <li>sidecar 仅监听 127.0.0.1</li>
          <li>每次启动生成临时 Bearer Token</li>
          <li>前端不开放通用 Shell 权限</li>
          <li>应用退出时回收子进程</li>
        </>
      )}
    </ul>
  );
}

export default App;
