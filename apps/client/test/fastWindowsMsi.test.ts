import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("fast Windows MSI build", () => {
  it("keeps the local build portable while relaxing only release optimization", async () => {
    const source = await readFile(
      new URL("../../../scripts/fast-windows-msi.mjs", import.meta.url),
      "utf8",
    );

    expect(source).toContain('CARGO_PROFILE_RELEASE_LTO: "false"');
    expect(source).toContain('CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16"');
    expect(source).toContain('CARGO_PROFILE_RELEASE_INCREMENTAL: "true"');
    expect(source).toContain('CARGO_TARGET_DIR: targetDir');
    expect(source).toContain('target/fast-msi');
    expect(source).toContain('"build", "--bundles", "msi"');
    expect(source).not.toContain("desktop-power");
    expect(source).not.toContain("sidecar");
  });
});
