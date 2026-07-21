import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import {
  IMAGE_QUALITIES,
  IMAGE_SIZES,
  MAX_REFERENCE_IMAGE_BYTES,
  type ImageGenerationResult,
  type ImageQuality,
  type ImageSize,
} from "./imageGeneration";
import { providerSession, type ProviderSessionSnapshot } from "./providerSession";

export function ImageGenerationPanel({
  onClose,
  openProviders,
}: {
  onClose: () => void;
  openProviders: () => void;
}) {
  const [snapshot, setSnapshot] = useState<ProviderSessionSnapshot>(providerSession.snapshot);
  const [providerId, setProviderId] = useState(snapshot.selectedProviderId ?? "");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState<ImageSize>("1024x1024");
  const [quality, setQuality] = useState<ImageQuality>("low");
  const [reference, setReference] = useState<File>();
  const [referenceUrl, setReferenceUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<ImageGenerationResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | undefined>(undefined);

  const selectedProvider = snapshot.profiles.find((profile) => profile.id === providerId);
  const availableModels = selectedProvider?.enabledModels ?? [];
  const imageReady = snapshot.unlocked && Boolean(selectedProvider && model);
  const downloadName = `nkg-image-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  const modeLabel = reference ? "参考图编辑" : "文字生图";

  useEffect(() => {
    let active = true;
    const sync = () => { if (active) setSnapshot(providerSession.snapshot); };
    const unsubscribe = providerSession.subscribe(sync);
    providerSession.initialize().then(sync).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      active = false;
      unsubscribe();
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const preferredProviderId = snapshot.profiles.some((profile) => profile.id === providerId)
      ? providerId
      : snapshot.selectedProviderId ?? snapshot.profiles[0]?.id ?? "";
    if (preferredProviderId !== providerId) setProviderId(preferredProviderId);
  }, [providerId, snapshot.profiles, snapshot.selectedProviderId]);

  useEffect(() => {
    if (availableModels.includes(model)) return;
    setModel(
      availableModels.find((candidate) => candidate === "gpt-image-2")
      ?? availableModels.find((candidate) => candidate.toLowerCase().includes("image"))
      ?? availableModels[0]
      ?? "",
    );
  }, [availableModels, model]);

  useEffect(() => {
    if (!reference) {
      setReferenceUrl("");
      return;
    }
    const url = URL.createObjectURL(reference);
    setReferenceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [reference]);

  const estimatedShape = useMemo(() => {
    if (size === "1536x1024") return "横向 3:2";
    if (size === "1024x1536") return "竖向 2:3";
    return "方形 1:1";
  }, [size]);

  function acceptReference(file?: File) {
    setError("");
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("参考图片仅支持 PNG、JPEG 或 WebP");
      return;
    }
    if (file.size > MAX_REFERENCE_IMAGE_BYTES) {
      setError("参考图片不能超过 20 MB");
      return;
    }
    setReference(file);
    setResult(undefined);
  }

  function clearReference() {
    setReference(undefined);
    if (inputRef.current) inputRef.current.value = "";
  }

  function chooseReference() {
    if (!inputRef.current) return;
    inputRef.current.value = "";
    inputRef.current.click();
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragging(false);
    acceptReference(event.dataTransfer.files[0]);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!imageReady || !prompt.trim() || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError("");
    try {
      setResult(await providerSession.generateImage({
        providerId,
        model,
        prompt,
        size,
        quality,
        ...(reference ? {
          referenceImage: { blob: reference, fileName: reference.name },
        } : {}),
        signal: controller.signal,
      }));
    } catch (cause: unknown) {
      if (cause instanceof Error && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = undefined;
        setBusy(false);
      }
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  return (
    <div className="image-studio-content">
      <header className="image-studio-header">
        <div>
          <span className="settings-kicker">IMAGE STUDIO</span>
          <h2>生图工作台</h2>
          <p>输入文字直接生成，或上传参考图后按描述编辑。</p>
        </div>
        <button aria-label="关闭生图工作台" className="icon-button" type="button" onClick={onClose}><CloseIcon /></button>
      </header>

      <div className="image-studio-grid">
        <form className="image-studio-form" onSubmit={(event) => void submit(event)}>
          {!snapshot.unlocked || snapshot.profiles.length === 0 ? (
            <button className="image-provider-banner" type="button" onClick={openProviders}>
              <SparkIcon />
              <span><strong>先配置生图模型</strong><small>添加 API URL、API Key，并启用 gpt-image-2</small></span>
              <ChevronIcon />
            </button>
          ) : null}

          <div className="image-field-row">
            <label>模型服务
              <select disabled={busy} value={providerId} onChange={(event) => setProviderId(event.currentTarget.value)}>
                {snapshot.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
              </select>
            </label>
            <label>生图模型
              <select disabled={busy || !selectedProvider} value={model} onChange={(event) => setModel(event.currentTarget.value)}>
                {availableModels.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
          </div>

          <label className="image-prompt-field">画面描述
            <textarea
              disabled={busy}
              maxLength={4000}
              placeholder={reference ? "例如：保留主体构图，把背景改成雨夜霓虹街道…" : "例如：一座漂浮在云海上的未来城市，电影感光线…"}
              rows={5}
              value={prompt}
              onChange={(event) => setPrompt(event.currentTarget.value)}
            />
            <small>{prompt.length} / 4000</small>
          </label>

          <div className="image-options-row">
            <label>尺寸
              <select disabled={busy} value={size} onChange={(event) => setSize(event.currentTarget.value as ImageSize)}>
                {IMAGE_SIZES.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              <small>{estimatedShape}</small>
            </label>
            <label>质量
              <select disabled={busy} value={quality} onChange={(event) => setQuality(event.currentTarget.value as ImageQuality)}>
                {IMAGE_QUALITIES.map((item) => <option key={item} value={item}>{qualityLabel(item)}</option>)}
              </select>
              <small>质量越高，生成时间通常越长</small>
            </label>
          </div>

          <div className="reference-heading">
            <div><strong>参考图片</strong><small>可选；上传后自动使用图片编辑接口</small></div>
            {reference ? <button type="button" onClick={clearReference}>移除</button> : null}
          </div>
          <input
            accept="image/png,image/jpeg,image/webp"
            className="visually-hidden"
            ref={inputRef}
            type="file"
            onChange={(event) => acceptReference(event.currentTarget.files?.[0])}
          />
          <button
            className={`reference-dropzone ${dragging ? "dragging" : ""} ${reference ? "has-image" : ""}`}
            disabled={busy}
            type="button"
            onClick={chooseReference}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            {referenceUrl ? (
              <><img alt="参考图预览" src={referenceUrl} /><span><strong>{reference?.name}</strong><small>{formatBytes(reference?.size ?? 0)} · 点击更换</small></span></>
            ) : (
              <><UploadIcon /><span><strong>点击或拖入参考图片</strong><small>PNG / JPEG / WebP，最大 20 MB</small></span></>
            )}
          </button>

          {error ? <div className="image-error" role="alert"><AlertIcon /><span>{error}</span></div> : null}
          <div className="image-submit-row">
            <span><SparkIcon />{modeLabel}</span>
            {busy ? (
              <button className="image-stop-button" type="button" onClick={stop}><StopIcon />停止生成</button>
            ) : (
              <button className="image-generate-button" disabled={!imageReady || !prompt.trim()} type="submit"><SparkIcon />开始生成</button>
            )}
          </div>
        </form>

        <section className="image-result-panel" aria-live="polite">
          {busy ? (
            <div className="image-generating"><span className="image-generating-orb"><SparkIcon /></span><strong>正在创作图片…</strong><small>高质量图片可能需要一两分钟，请保持应用打开</small><i /><i /><i /></div>
          ) : result ? (
            <div className="image-result">
              <div className={`image-result-frame ${result.size}`}><img alt="AI 生成结果" src={result.src} /></div>
              <div className="image-result-meta">
                <div><strong>{result.mode === "edit" ? "参考图编辑完成" : "图片生成完成"}</strong><small>{result.model} · {result.size} · {qualityLabel(result.quality)}</small></div>
                <a download={downloadName} href={result.src}><DownloadIcon />下载 PNG</a>
              </div>
              {result.revisedPrompt ? <details><summary>查看模型优化后的描述</summary><p>{result.revisedPrompt}</p></details> : null}
            </div>
          ) : (
            <div className="image-result-empty"><span><ImageIcon /></span><strong>生成结果会显示在这里</strong><small>你可以先用低质量快速试稿，满意后再提高质量。</small></div>
          )}
        </section>
      </div>
      <p className="image-privacy-note">参考图仅发送给当前选择的模型服务，不写入对话或本地数据库。</p>
    </div>
  );
}

function qualityLabel(quality: ImageQuality): string {
  if (quality === "low") return "低（快速试稿）";
  if (quality === "medium") return "中";
  if (quality === "high") return "高";
  return "自动";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Icon({ children }: { children: React.ReactNode }) { return <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">{children}</svg>; }
function CloseIcon() { return <Icon><path d="m6 6 12 12M18 6 6 18" /></Icon>; }
function SparkIcon() { return <Icon><path d="m12 3 1.2 4.1a5 5 0 0 0 3.4 3.4l4.1 1.2-4.1 1.2a5 5 0 0 0-3.4 3.4L12 20.4l-1.2-4.1a5 5 0 0 0-3.4-3.4l-4.1-1.2 4.1-1.2a5 5 0 0 0 3.4-3.4L12 3Z" /></Icon>; }
function ChevronIcon() { return <Icon><path d="m9 6 6 6-6 6" /></Icon>; }
function UploadIcon() { return <Icon><path d="M12 16V4m-4 4 4-4 4 4M5 14v5h14v-5" /></Icon>; }
function DownloadIcon() { return <Icon><path d="M12 4v12m-4-4 4 4 4-4M5 19h14" /></Icon>; }
function AlertIcon() { return <Icon><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v5M12 17h.01" /></Icon>; }
function StopIcon() { return <Icon><rect height="10" rx="2" width="10" x="7" y="7" /></Icon>; }
function ImageIcon() { return <Icon><rect height="16" rx="2" width="18" x="3" y="4" /><circle cx="9" cy="10" r="2" /><path d="m4 18 5-4 3 2 3-3 5 4" /></Icon>; }
