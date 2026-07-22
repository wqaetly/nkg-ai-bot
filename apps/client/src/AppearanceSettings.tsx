import { useRef, useState, type ChangeEvent } from "react";
import {
  MAX_UI_SCALE,
  MIN_UI_SCALE,
  prepareBackgroundImage,
  stepUiScale,
  UI_SCALE_STEP,
  type AppearancePreferences,
  type ThemeMode,
} from "./appearance";

export function AppearanceSettings({
  value,
  themeMode,
  onChange,
  onThemeModeChange,
}: {
  value: AppearancePreferences;
  themeMode: ThemeMode;
  onChange: (next: AppearancePreferences) => boolean;
  onThemeModeChange: (mode: ThemeMode) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function selectBackground(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const backgroundImage = await prepareBackgroundImage(file);
      if (!onChange({ ...value, backgroundImage })) {
        setError("背景图保存失败，本机可用存储空间可能不足");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function updateOpacity(backgroundOpacity: number) {
    if (!onChange({ ...value, backgroundOpacity })) {
      setError("透明度设置保存失败");
    } else {
      setError("");
    }
  }

  function removeBackground() {
    if (!onChange({ ...value, backgroundImage: "" })) {
      setError("移除背景图失败");
    } else {
      setError("");
    }
  }

  function updateUiScale(uiScale: number) {
    if (!onChange({ ...value, uiScale })) {
      setError("界面缩放设置保存失败");
    } else {
      setError("");
    }
  }

  return (
    <section className="appearance-form">
      <div className="settings-section-heading">
        <div><strong>背景与界面</strong><small>主页保持背景清晰，打开的弹窗使用毛玻璃质感</small></div>
        <span className="appearance-live-dot">实时</span>
      </div>

      <div className="appearance-theme-setting">
        <span><strong>颜色模式</strong><small>选择应用使用的明暗外观</small></span>
        <div aria-label="颜色模式" className="appearance-theme-options" role="radiogroup">
          {(["system", "light", "dark"] as ThemeMode[]).map((mode) => (
            <button
              aria-checked={themeMode === mode}
              className={themeMode === mode ? "active" : ""}
              key={mode}
              role="radio"
              type="button"
              onClick={() => onThemeModeChange(mode)}
            >
              {mode === "system" ? "跟随系统" : mode === "light" ? "浅色" : "深色"}
            </button>
          ))}
        </div>
      </div>

      <div className="appearance-scale-setting">
        <span><strong>界面与字体缩放</strong><small>像 VS Code 一样同步缩放文字、控件、图标与弹窗</small></span>
        <div className="appearance-scale-controls">
          <button aria-label="缩小界面" disabled={value.uiScale <= MIN_UI_SCALE} type="button" onClick={() => updateUiScale(stepUiScale(value.uiScale, -1))}>−</button>
          <button className="appearance-scale-value" title="恢复 100%" type="button" onClick={() => updateUiScale(1)}>{Math.round(value.uiScale * 100)}%</button>
          <button aria-label="放大界面" disabled={value.uiScale >= MAX_UI_SCALE} type="button" onClick={() => updateUiScale(stepUiScale(value.uiScale, 1))}>＋</button>
        </div>
      </div>
      <input
        aria-label="界面缩放比例"
        className="appearance-scale-range"
        max={MAX_UI_SCALE}
        min={MIN_UI_SCALE}
        step={UI_SCALE_STEP}
        type="range"
        value={value.uiScale}
        onChange={(event) => updateUiScale(Number(event.currentTarget.value))}
      />
      <p className="field-hint">快捷键：Ctrl/Cmd + 加号或减号调整，Ctrl/Cmd + 0 恢复。</p>

      <div className={`background-preview${value.backgroundImage ? " has-image" : ""}`}>
        {value.backgroundImage
              ? <img alt="当前自定义背景预览" src={value.backgroundImage} style={{ opacity: value.backgroundOpacity }} />
          : <div><span>✦</span><strong>默认氛围背景</strong><small>选择图片后可实时预览毛玻璃效果</small></div>}
        <div className="background-preview-glass"><span>弹窗材质预览</span><small>Glass dialog preview</small></div>
      </div>

      <input
        ref={inputRef}
        accept="image/png,image/jpeg,image/webp"
        className="visually-hidden-input"
        type="file"
        onChange={(event) => void selectBackground(event)}
      />
      <div className="background-actions">
        <button className="primary-button" disabled={busy} type="button" onClick={() => inputRef.current?.click()}>
          {busy ? "正在处理…" : value.backgroundImage ? "更换背景图" : "选择背景图"}
        </button>
        {value.backgroundImage ? <button className="ghost-button" disabled={busy} type="button" onClick={removeBackground}>恢复默认背景</button> : null}
      </div>
      <p className="field-hint">支持 PNG、JPEG、WebP，最大 12 MB；图片会在本机压缩后保存，不会上传。</p>

      <label className="background-opacity-heading" htmlFor="background-opacity">
        <span><strong>背景图透明度</strong><small>数值越高，背景图越清晰</small></span>
        <b>{Math.round(value.backgroundOpacity * 100)}%</b>
      </label>
      <input
        disabled={!value.backgroundImage}
        id="background-opacity"
        max="100"
        min="0"
        type="range"
        value={Math.round(value.backgroundOpacity * 100)}
        onChange={(event) => updateOpacity(Number(event.currentTarget.value) / 100)}
      />
      {!value.backgroundImage ? <p className="field-hint">选择自定义背景图后即可调节透明度。</p> : null}
      {error ? <p className="form-message error" role="alert">{error}</p> : null}
    </section>
  );
}
