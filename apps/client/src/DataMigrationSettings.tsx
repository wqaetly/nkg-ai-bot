import { useEffect, useRef, useState } from "react";
import {
  createMigrationBundle,
  downloadMigrationBundle,
  parseMigrationBundle,
  restartAfterImport,
  stageMigrationBundle,
  type AppMigrationBundle,
} from "./dataMigration";
import {
  cancelLanSyncShare,
  discoverLanSyncDevices,
  getLanSyncShareStatus,
  isValidPairingCode,
  receiveLanSyncBundle,
  startLanSyncShare,
  type LanSyncOffer,
  type LanSyncShareInfo,
} from "./lanSync";

const MAX_MIGRATION_BYTES = 64 * 1024 * 1024;

export function DataMigrationSettings() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<AppMigrationBundle>();
  const [busy, setBusy] = useState<"export" | "import" | "share" | "discover" | "receive">();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [sharing, setSharing] = useState<LanSyncShareInfo>();
  const [offers, setOffers] = useState<LanSyncOffer[]>([]);
  const [selectedOffer, setSelectedOffer] = useState<LanSyncOffer>();
  const [pairingCode, setPairingCode] = useState("");

  useEffect(() => {
    if (!sharing) return;
    const timer = window.setInterval(() => {
      void getLanSyncShareStatus().then((status) => {
        if (status.transferred) {
          window.clearInterval(timer);
          setSharing(undefined);
          setNotice("数据已加密发送到另一台设备，本次同步会话已自动关闭");
        } else if (!status.active) {
          window.clearInterval(timer);
          setSharing(undefined);
          setNotice("局域网同步会话已结束");
        }
      }).catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [sharing]);

  useEffect(() => () => { void cancelLanSyncShare(); }, []);

  async function exportData() {
    setBusy("export");
    setError("");
    setNotice("");
    try {
      const bundle = await createMigrationBundle();
      const path = await downloadMigrationBundle(bundle);
      setNotice(`迁移包已保存到 ${path}（${bundle.counts.conversations} 个对话，${bundle.counts.messages} 条消息）`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(undefined);
    }
  }

  async function chooseImport(file: File | undefined) {
    if (!file) return;
    setError("");
    setNotice("");
    try {
      if (file.size > MAX_MIGRATION_BYTES) throw new Error("迁移文件不能超过 64 MB");
      setPending(parseMigrationBundle(await file.text()));
    } catch (cause) {
      setPending(undefined);
      setError(messageOf(cause));
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function importData() {
    if (!pending) return;
    setBusy("import");
    setError("");
    try {
      const current = await createMigrationBundle();
      await downloadMigrationBundle(current, "nkg-auto-before-import");
      await stageMigrationBundle(pending);
      setNotice("导入完成，正在重启并载入全部数据…");
      window.setTimeout(restartAfterImport, 350);
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(undefined);
    }
  }

  async function shareOnLan() {
    setBusy("share");
    setError("");
    setNotice("");
    try {
      setSharing(await startLanSyncShare());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(undefined);
    }
  }

  async function stopSharing() {
    await cancelLanSyncShare();
    setSharing(undefined);
    setNotice("已停止局域网发送");
  }

  async function findDevices() {
    setBusy("discover");
    setError("");
    setNotice("");
    setSelectedOffer(undefined);
    try {
      const found = await discoverLanSyncDevices();
      setOffers(found);
      if (found.length === 0) setNotice("暂未发现发送设备，请确认两台设备连接同一 WiFi 或其中一台的热点");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(undefined);
    }
  }

  async function receiveFromLan() {
    if (!selectedOffer || !isValidPairingCode(pairingCode)) return;
    setBusy("receive");
    setError("");
    setNotice("");
    try {
      const bundle = await receiveLanSyncBundle(selectedOffer, pairingCode);
      setPending(bundle);
      setSelectedOffer(undefined);
      setPairingCode("");
      setNotice("数据已加密接收，请核对数量后确认导入");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="data-migration-settings">
      <div className="migration-hero">
        <span className="migration-hero-icon"><TransferIcon /></span>
        <div>
          <h3>一键迁移全部应用数据</h3>
          <p>把当前设备的对话、消息、Skill、配置、外观、记忆与加密凭据打包，在另一台设备原样恢复。</p>
        </div>
      </div>

      <div className="migration-content-list" aria-label="迁移内容">
        <span><CheckIcon /><strong>聊天记录</strong><small>全部对话与完整消息</small></span>
        <span><CheckIcon /><strong>Skill 与记忆</strong><small>版本、能力和本地学习数据</small></span>
        <span><CheckIcon /><strong>配置与外观</strong><small>模型、搜索、MCP 和界面偏好</small></span>
        <span><LockIcon /><strong>加密凭据</strong><small>Stronghold 快照与设备密钥</small></span>
      </div>

      <section className="lan-sync-panel" aria-labelledby="lan-sync-title">
        <header>
          <span className="lan-sync-icon"><WifiIcon /></span>
          <div>
            <h4 id="lan-sync-title">局域网直接同步</h4>
            <p>两台设备连接同一 WiFi，或连接其中一台设备开启的热点，无需中转文件。</p>
          </div>
        </header>
        <div className="lan-sync-actions">
          <button className="primary-button" disabled={Boolean(busy) || Boolean(sharing)} type="button" onClick={() => void shareOnLan()}>
            {busy === "share" ? "正在准备…" : "从此设备发送"}
          </button>
          <button className="ghost-button" disabled={Boolean(busy) || Boolean(sharing)} type="button" onClick={() => void findDevices()}>
            {busy === "discover" ? "正在搜索…" : "搜索附近设备"}
          </button>
        </div>

        {sharing ? (
          <div className="lan-share-session" role="status">
            <span className="lan-pulse" />
            <div><strong>等待另一台设备连接</strong><small>在接收设备上搜索，然后输入配对码</small></div>
            <code aria-label="六位配对码">{sharing.pairingCode}</code>
            <button className="ghost-button" type="button" onClick={() => void stopSharing()}>停止</button>
          </div>
        ) : null}

        {offers.length > 0 && !sharing ? (
          <div className="lan-device-list" aria-label="发现的设备">
            {offers.map((offer) => (
              <button
                className={selectedOffer?.sessionId === offer.sessionId ? "selected" : ""}
                key={offer.sessionId}
                type="button"
                onClick={() => { setSelectedOffer(offer); setPairingCode(""); }}
              >
                <DeviceIcon /><span><strong>{offer.deviceName}</strong><small>{offer.host}</small></span><ChevronIcon />
              </button>
            ))}
          </div>
        ) : null}

        {selectedOffer ? (
          <div className="lan-pairing-form">
            <label htmlFor="lan-pairing-code">输入 {selectedOffer.deviceName} 上显示的 6 位配对码</label>
            <div>
              <input
                autoComplete="one-time-code"
                id="lan-pairing-code"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={pairingCode}
                onChange={(event) => setPairingCode(event.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
              />
              <button className="primary-button" disabled={busy === "receive" || !isValidPairingCode(pairingCode)} type="button" onClick={() => void receiveFromLan()}>
                {busy === "receive" ? "正在接收…" : "安全接收"}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <div className="migration-actions-grid">
        <article>
          <div><ExportIcon /><span><strong>导出此设备</strong><small>生成一个可迁移的 .nkgbackup 文件</small></span></div>
          <button className="primary-button" disabled={Boolean(busy)} type="button" onClick={() => void exportData()}>
            {busy === "export" ? "正在打包…" : "导出全部数据"}
          </button>
        </article>
        <article>
          <div><ImportIcon /><span><strong>导入到此设备</strong><small>选择迁移包并完整覆盖当前数据</small></span></div>
          <input
            accept=".nkgbackup,application/json"
            aria-label="选择 NKG 迁移包"
            hidden
            ref={inputRef}
            type="file"
            onChange={(event) => void chooseImport(event.currentTarget.files?.[0])}
          />
          <button className="ghost-button" disabled={Boolean(busy)} type="button" onClick={() => inputRef.current?.click()}>
            选择迁移文件
          </button>
        </article>
      </div>

      {pending ? (
        <div className="migration-confirm" role="status">
          <div>
            <strong>准备导入 {new Date(pending.exportedAt).toLocaleString()}</strong>
            <small>{pending.counts.conversations} 个对话 · {pending.counts.messages} 条消息 · {pending.counts.skills} 个 Skill 版本 · {pending.counts.memories} 条记忆</small>
          </div>
          <p>导入会覆盖此设备当前数据。应用会先自动导出一份当前备份，然后重启完成恢复。</p>
          <footer>
            <button className="ghost-button" disabled={Boolean(busy)} type="button" onClick={() => setPending(undefined)}>取消</button>
            <button className="primary-button" disabled={Boolean(busy)} type="button" onClick={() => void importData()}>
              {busy === "import" ? "正在迁移…" : "备份当前数据并导入"}
            </button>
          </footer>
        </div>
      ) : null}

      <p className="migration-security-note"><LockIcon />迁移包包含可解锁 API Key 的设备密钥，等同于完整账号备份。请只传给自己的设备并妥善保管。</p>
      {notice ? <p className="form-message success" role="status">{notice}</p> : null}
      {error ? <p className="form-message error" role="alert">{error}</p> : null}
    </section>
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function Svg({ children }: { children: React.ReactNode }) { return <svg aria-hidden="true" viewBox="0 0 24 24">{children}</svg>; }
function TransferIcon() { return <Svg><path d="M5 8h13m0 0-3-3m3 3-3 3M19 16H6m0 0 3-3m-3 3 3 3" /></Svg>; }
function ExportIcon() { return <Svg><path d="M12 3v12m0-12-4 4m4-4 4 4" /><path d="M5 14v6h14v-6" /></Svg>; }
function ImportIcon() { return <Svg><path d="M12 15V3m0 12-4-4m4 4 4-4" /><path d="M5 14v6h14v-6" /></Svg>; }
function CheckIcon() { return <Svg><path d="m5 12 4 4L19 6" /></Svg>; }
function LockIcon() { return <Svg><rect height="10" rx="2" width="14" x="5" y="10" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></Svg>; }
function WifiIcon() { return <Svg><path d="M5 10a11 11 0 0 1 14 0M8 14a6 6 0 0 1 8 0m-4 4h.01" /></Svg>; }
function DeviceIcon() { return <Svg><rect height="16" rx="2" width="12" x="6" y="4" /><path d="M10 17h4" /></Svg>; }
function ChevronIcon() { return <Svg><path d="m9 6 6 6-6 6" /></Svg>; }
