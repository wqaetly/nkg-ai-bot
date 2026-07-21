import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));

describe("architecture documentation", () => {
  it("describes the implemented five-platform portable default", () => {
    const routing = document("runtime-routing.md");
    expect(routing).toContain("Windows、macOS、Linux、Android、iOS：默认使用 `portable`");
    expect(routing).toContain("desktop-power");
    expect(routing).not.toContain("Android/iOS 在 Runtime 启动前将 `globalThis.fetch` 替换");
  });

  it("keeps release size evidence distinct from debug artifacts", () => {
    const audit = document("implementation-audit-2026-07-20.md");
    expect(audit).toContain("Debug APK | 241.12 MiB");
    expect(audit).toContain("Release APK | 14.39 MiB");
    expect(audit).toContain("Release AAB | 8.23 MiB");
    expect(audit).toContain("可选 Google Play 上传基线，不在默认 Release 中生成");
    expect(audit).toContain("不等同于五端真机产品验收");
  });
});

function document(name: string): string {
  return readFileSync(join(root, "docs", "architecture", name), "utf8");
}
