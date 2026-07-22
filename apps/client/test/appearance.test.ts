import { describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_IMAGE_STORAGE_KEY,
  BACKGROUND_OPACITY_STORAGE_KEY,
  clampBackgroundOpacity,
  clampUiScale,
  calculateLogicalViewportSize,
  DEFAULT_UI_SCALE,
  loadAppearancePreferences,
  loadThemeMode,
  nextThemeMode,
  resolveTheme,
  saveAppearancePreferences,
  saveThemeMode,
  stepUiScale,
  THEME_STORAGE_KEY,
  UI_SCALE_STORAGE_KEY,
} from "../src/appearance";

describe("appearance preferences", () => {
  it("falls back to the system preference for invalid persisted values", () => {
    expect(loadThemeMode({ getItem: () => "sepia" })).toBe("system");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("cycles through system, light and dark", () => {
    expect(nextThemeMode("system")).toBe("light");
    expect(nextThemeMode("light")).toBe("dark");
    expect(nextThemeMode("dark")).toBe("system");
  });

  it("persists the selected mode without requiring browser storage", () => {
    const setItem = vi.fn();
    saveThemeMode("dark", { setItem });
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "dark");
  });

  it("loads, clamps and persists glass background preferences", () => {
    const saved = new Map<string, string>([
      [BACKGROUND_IMAGE_STORAGE_KEY, "data:image/webp;base64,test"],
      [BACKGROUND_OPACITY_STORAGE_KEY, "1.8"],
      [UI_SCALE_STORAGE_KEY, "1.26"],
    ]);
    const preferences = loadAppearancePreferences({ getItem: (key) => saved.get(key) ?? null });
    expect(preferences).toEqual({
      backgroundImage: "data:image/webp;base64,test",
      backgroundOpacity: 1,
      uiScale: 1.3,
    });
    expect(clampBackgroundOpacity(-0.2)).toBe(0);
    expect(clampUiScale(9)).toBe(1.4);
    expect(clampUiScale(Number.NaN)).toBe(DEFAULT_UI_SCALE);
    expect(stepUiScale(1, 1)).toBe(1.1);

    const setItem = vi.fn();
    const removeItem = vi.fn();
    expect(saveAppearancePreferences(
      { backgroundImage: "", backgroundOpacity: 0.45, uiScale: 1.1 },
      preferences,
      { setItem, removeItem },
    )).toBe(true);
    expect(removeItem).toHaveBeenCalledWith(BACKGROUND_IMAGE_STORAGE_KEY);
    expect(setItem).toHaveBeenCalledWith(BACKGROUND_OPACITY_STORAGE_KEY, "0.45");
    expect(setItem).toHaveBeenCalledWith(UI_SCALE_STORAGE_KEY, "1.1");
  });

  it("calculates a logical viewport that fills the window after scaling", () => {
    const viewport = calculateLogicalViewportSize(1600, 900, 1.2);

    expect(viewport.width * 1.2).toBeCloseTo(1600);
    expect(viewport.height * 1.2).toBeCloseTo(900);
    expect(calculateLogicalViewportSize(1600, 900, Number.NaN)).toEqual({ width: 1600, height: 900 });
  });
});
