import { describe, expect, it, vi } from "vitest";
import {
  loadThemeMode,
  nextThemeMode,
  resolveTheme,
  saveThemeMode,
  THEME_STORAGE_KEY,
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
});
