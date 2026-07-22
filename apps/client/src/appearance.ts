export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemeMode, "system">;

export const THEME_STORAGE_KEY = "nkg.appearance.theme";
export const BACKGROUND_IMAGE_STORAGE_KEY = "nkg.appearance.backgroundImage";
export const BACKGROUND_OPACITY_STORAGE_KEY = "nkg.appearance.backgroundOpacity";
export const UI_SCALE_STORAGE_KEY = "nkg.appearance.uiScale";
export const DEFAULT_BACKGROUND_OPACITY = 0.46;
export const DEFAULT_UI_SCALE = 1;
export const MIN_UI_SCALE = 0.8;
export const MAX_UI_SCALE = 1.4;
export const UI_SCALE_STEP = 0.1;
export const MAX_BACKGROUND_SOURCE_BYTES = 12 * 1024 * 1024;

export interface AppearancePreferences {
  backgroundImage: string;
  backgroundOpacity: number;
  uiScale: number;
}

export interface LogicalViewportSize {
  width: number;
  height: number;
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

export function loadThemeMode(storage: Pick<Storage, "getItem"> = localStorage): ThemeMode {
  try {
    const saved = storage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

export function saveThemeMode(
  mode: ThemeMode,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Appearance still applies for the current session when storage is unavailable.
  }
}

export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  return mode === "system" ? (systemDark ? "dark" : "light") : mode;
}

export function nextThemeMode(mode: ThemeMode): ThemeMode {
  if (mode === "system") return "light";
  if (mode === "light") return "dark";
  return "system";
}

export function themeModeLabel(mode: ThemeMode): string {
  if (mode === "light") return "浅色";
  if (mode === "dark") return "深色";
  return "跟随系统";
}

export function clampBackgroundOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BACKGROUND_OPACITY;
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}

export function clampUiScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_UI_SCALE;
  const clamped = Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, value));
  return Number((Math.round(clamped / UI_SCALE_STEP) * UI_SCALE_STEP).toFixed(2));
}

export function stepUiScale(value: number, direction: -1 | 1): number {
  return clampUiScale(value + direction * UI_SCALE_STEP);
}

export function calculateLogicalViewportSize(
  viewportWidth: number,
  viewportHeight: number,
  uiScale: number,
): LogicalViewportSize {
  const scale = clampUiScale(uiScale);
  return {
    width: Math.max(1, viewportWidth / scale),
    height: Math.max(1, viewportHeight / scale),
  };
}

export function loadAppearancePreferences(
  storage: Pick<Storage, "getItem"> = localStorage,
): AppearancePreferences {
  try {
    const rawOpacity = Number(storage.getItem(BACKGROUND_OPACITY_STORAGE_KEY));
    const rawUiScale = Number(storage.getItem(UI_SCALE_STORAGE_KEY));
    return {
      backgroundImage: storage.getItem(BACKGROUND_IMAGE_STORAGE_KEY) ?? "",
      backgroundOpacity: storage.getItem(BACKGROUND_OPACITY_STORAGE_KEY) === null
        ? DEFAULT_BACKGROUND_OPACITY
        : clampBackgroundOpacity(rawOpacity),
      uiScale: storage.getItem(UI_SCALE_STORAGE_KEY) === null
        ? DEFAULT_UI_SCALE
        : clampUiScale(rawUiScale),
    };
  } catch {
    return { backgroundImage: "", backgroundOpacity: DEFAULT_BACKGROUND_OPACITY, uiScale: DEFAULT_UI_SCALE };
  }
}

export function saveAppearancePreferences(
  next: AppearancePreferences,
  previous: AppearancePreferences,
  storage: Pick<Storage, "setItem" | "removeItem"> = localStorage,
): boolean {
  try {
    if (next.backgroundImage !== previous.backgroundImage) {
      if (next.backgroundImage) storage.setItem(BACKGROUND_IMAGE_STORAGE_KEY, next.backgroundImage);
      else storage.removeItem(BACKGROUND_IMAGE_STORAGE_KEY);
    }
    if (next.backgroundOpacity !== previous.backgroundOpacity) {
      storage.setItem(BACKGROUND_OPACITY_STORAGE_KEY, String(clampBackgroundOpacity(next.backgroundOpacity)));
    }
    if (next.uiScale !== previous.uiScale) {
      storage.setItem(UI_SCALE_STORAGE_KEY, String(clampUiScale(next.uiScale)));
    }
    return true;
  } catch {
    return false;
  }
}

export async function prepareBackgroundImage(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error("背景图仅支持 PNG、JPEG 或 WebP");
  }
  if (!file.size) throw new Error("背景图片为空");
  if (file.size > MAX_BACKGROUND_SOURCE_BYTES) throw new Error("背景图片不能超过 12 MB");

  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(sourceUrl);
    const maxWidth = 2200;
    const maxHeight = 1600;
    const scale = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
    let width = Math.max(1, Math.round(image.naturalWidth * scale));
    let height = Math.max(1, Math.round(image.naturalHeight * scale));
    let quality = 0.84;
    let result = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("当前设备无法处理背景图片");
      context.drawImage(image, 0, 0, width, height);
      result = canvas.toDataURL("image/webp", quality);
      if (result.length <= 1_600_000) return result;
      width = Math.max(1, Math.round(width * 0.82));
      height = Math.max(1, Math.round(height * 0.82));
      quality = Math.max(0.58, quality - 0.08);
    }
    if (result.length > 1_900_000) throw new Error("图片处理后仍然过大，请选择尺寸更小的背景图");
    return result;
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取背景图片"));
    image.src = source;
  });
}
