import { describe, expect, it } from "vitest";
import {
  createTauriPortableCapabilities,
  createTauriReadOnlyToolHost,
} from "../src/tauriToolHost.js";

const env = {
  workingDir: "C:/must-not-cross-native-boundary",
  allowedTools: ["read_file", "write_files", "run_bash"] as const,
  allowBash: true,
  timeoutMs: 10_000,
  maxOutputChars: 4_000,
};

describe("Tauri portable ToolHost", () => {
  it("only forwards read operations and never forwards workingDir", async () => {
    const calls: unknown[][] = [];
    const invoke = async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]);
      return { ok: true, output: "hello" } as T;
    };
    const host = createTauriReadOnlyToolHost({ invoke });

    await expect(host.callTool({
      tool: "read_file",
      args: { path: "notes/readme.md", nested: { ignored: true } },
    }, env)).resolves.toEqual({ ok: true, output: "hello" });
    expect(calls).toEqual([["runtime_tool_call", {
        call: { tool: "read_file", args: { path: "notes/readme.md" } },
        policy: { allowedTools: ["read_file"], maxOutputChars: 4_000 },
      }]]);
  });

  it.each(["write_files", "run_bash"] as const)(
    "denies %s before invoking native code",
    async (tool) => {
      let invoked = false;
      const invoke = async <T>() => {
        invoked = true;
        return undefined as T;
      };
      const host = createTauriReadOnlyToolHost({ invoke });
      const result = await host.callTool({ tool, args: {} }, env);
      expect(result).toMatchObject({ ok: false, output: { tool } });
      expect(invoked).toBe(false);
    },
  );

  it("advertises filesystem.read without write or process capabilities", () => {
    const manifest = createTauriPortableCapabilities("android");
    expect(manifest.platform).toBe("android");
    expect(manifest.available.has("filesystem.read")).toBe(true);
    expect(manifest.available.has("filesystem.write")).toBe(false);
    expect(manifest.available.has("process.spawn")).toBe(false);
  });
});
