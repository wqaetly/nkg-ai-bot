import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

type ModelPingState =
  | { model: string; state: "testing" }
  | { latencyMs: number; model: string; state: "success" }
  | { message: string; model: string; state: "error" };

export function ModelSelector({
  "aria-label": ariaLabel,
  disabled = false,
  models,
  onChange,
  onPing,
  value,
}: {
  "aria-label"?: string;
  disabled?: boolean;
  models: string[];
  onChange: (model: string) => void;
  onPing: (model: string, signal: AbortSignal) => Promise<number>;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pingState, setPingState] = useState<ModelPingState>();
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pingAbortRef = useRef<AbortController | undefined>(undefined);
  const listboxId = useId();
  const visibleModels = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return normalizedQuery
      ? models.filter((model) => model.toLocaleLowerCase().includes(normalizedQuery))
      : models;
  }, [models, query]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(344, window.innerWidth - 28);
      const left = Math.max(14, Math.min(rect.right - width, window.innerWidth - width - 14));
      setPopoverStyle({
        bottom: window.innerHeight - rect.top + 9,
        left,
        width,
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (pingState && pingState.model !== value) setPingState(undefined);
  }, [pingState, value]);

  useEffect(() => () => pingAbortRef.current?.abort(), []);

  function toggle() {
    if (disabled) return;
    setOpen((current) => {
      if (!current) setQuery("");
      return !current;
    });
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!open) {
      setQuery("");
      setOpen(true);
    }
  }

  function selectModel(model: string) {
    if (model !== value) onChange(model);
    setQuery("");
    setOpen(false);
  }

  async function pingCurrentModel() {
    pingAbortRef.current?.abort();
    const controller = new AbortController();
    pingAbortRef.current = controller;
    setPingState({ model: value, state: "testing" });
    try {
      const latencyMs = await onPing(value, controller.signal);
      if (!controller.signal.aborted) {
        setPingState({ latencyMs, model: value, state: "success" });
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setPingState({
          message: cause instanceof Error ? cause.message : String(cause),
          model: value,
          state: "error",
        });
      }
    } finally {
      if (pingAbortRef.current === controller) pingAbortRef.current = undefined;
    }
  }

  const pinging = pingState?.state === "testing";

  return (
    <div className={`composer-model-selector ${open ? "open" : ""}`} ref={rootRef}>
      <button
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel ?? "选择模型"}
        className="model-selector-trigger"
        disabled={disabled}
        ref={triggerRef}
        type="button"
        onClick={toggle}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="model-selector-spark"><SparkIcon /></span>
        <span className="model-selector-value" title={value}>{value}</span>
        <ChevronDownIcon />
      </button>

      {open ? createPortal(
        <div className="model-selector-popover" ref={popoverRef} style={popoverStyle}>
          <div className="model-selector-toolbar">
            <div className="model-selector-search">
              <SearchIcon />
              <input
                aria-label="搜索模型"
                placeholder="搜索模型…"
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
              {query ? (
                <button aria-label="清空模型搜索" type="button" onClick={() => setQuery("")}><CloseIcon /></button>
              ) : null}
            </div>
            <button
              aria-label={`Ping 模型 ${value}`}
              className={`model-ping-button ${pingState?.state ?? ""}`}
              disabled={pinging}
              title={`发送最小请求，检测 ${value} 是否可用`}
              type="button"
              onClick={() => void pingCurrentModel()}
            >
              {pinging ? <span className="model-ping-spinner" /> : <BoltIcon />}
            </button>
          </div>

          {pingState ? (
            <div aria-live="polite" className={`model-ping-status ${pingState.state}`}>
              <span />
              {pingState.state === "testing"
                ? <p><strong>正在检测</strong><small>{pingState.model}</small></p>
                : pingState.state === "success"
                  ? <p><strong>模型可用 · {pingState.latencyMs} ms</strong><small>{pingState.model}</small></p>
                  : <p><strong>模型暂不可用</strong><small title={pingState.message}>{pingState.message}</small></p>}
            </div>
          ) : null}

          <div aria-label="模型列表" className="model-selector-options" id={listboxId} role="listbox">
            {visibleModels.map((model) => (
              <button
                aria-selected={model === value}
                className={`model-selector-option ${model === value ? "selected" : ""}`}
                key={model}
                role="option"
                type="button"
                onClick={() => selectModel(model)}
              >
                <span className="model-option-mark">AI</span>
                <span title={model}>{model}</span>
                {model === value ? <CheckIcon /> : null}
              </button>
            ))}
            {visibleModels.length === 0 ? (
              <div className="model-selector-empty"><SearchIcon /><span>没有匹配的模型</span></div>
            ) : null}
          </div>
          <footer><span>{visibleModels.length} 个模型</span><small>闪电按钮检测当前模型</small></footer>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function Svg({ children }: { children: React.ReactNode }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24">{children}</svg>;
}

function SparkIcon() { return <Svg><path d="m12 3 1.45 5.55L19 10l-5.55 1.45L12 17l-1.45-5.55L5 10l5.55-1.45L12 3Z" /><path d="m18.5 16 .6 2.4 2.4.6-2.4.6-.6 2.4-.6-2.4-2.4-.6 2.4-.6.6-2.4Z" /></Svg>; }
function ChevronDownIcon() { return <Svg><path d="m7 9.5 5 5 5-5" /></Svg>; }
function SearchIcon() { return <Svg><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4.5 4.5" /></Svg>; }
function CloseIcon() { return <Svg><path d="m7 7 10 10M17 7 7 17" /></Svg>; }
function BoltIcon() { return <Svg><path d="m13.5 2-8 12h6l-1 8 8-12h-6l1-8Z" /></Svg>; }
function CheckIcon() { return <Svg><path d="m5 12.5 4 4L19 6.5" /></Svg>; }
