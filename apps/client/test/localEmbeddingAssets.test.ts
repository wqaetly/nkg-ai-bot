import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("bundled local embedding assets", () => {
  it("pins the q8 BGE model and permits only local WASM loading", async () => {
    const model = await readFile(new URL(
      "../public/models/Xenova/bge-small-zh-v1.5/onnx/model_quantized.onnx",
      import.meta.url,
    ));
    expect(model.byteLength).toBe(24_010_842);
    expect(createHash("sha256").update(model).digest("hex"))
      .toBe("15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc");

    const worker = await readFile(new URL("../src/localEmbedding.worker.ts", import.meta.url), "utf8");
    expect(worker).toContain("env.allowRemoteModels = false");
    expect(worker).toContain('env.localModelPath = "/models/"');
    expect(worker).toContain('device: "wasm"');
    expect(worker).toContain('dtype: "q8"');
    expect(worker).toContain('pooling: "cls", normalize: true');

    const tauriConfig = JSON.parse(await readFile(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    )) as { app: { security: { csp: string } } };
    expect(tauriConfig.app.security.csp).toContain("connect-src 'self'");
    expect(tauriConfig.app.security.csp).toContain("'wasm-unsafe-eval'");
    expect(tauriConfig.app.security.csp).toContain("worker-src 'self'");
  });
});
