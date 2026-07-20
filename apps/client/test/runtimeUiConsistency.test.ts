import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("runtime UI consistency", () => {
  it("describes the configured backend instead of inferring behavior from platform", async () => {
    const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

    expect(source).toContain('boot.backend === "in-process"');
    expect(source).toContain("五端进程内");
    expect(source).toContain("显式 sidecar");
    expect(source).not.toContain("const isMobile =");
  });

  it("loads the Runtime composition as a split production chunk", async () => {
    const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

    expect(source).toContain('import("./runtime")');
    expect(source).not.toContain('from "./runtime"');
    expect(source).toContain('lazy(() => import("./ChatPage")');
  });
});
