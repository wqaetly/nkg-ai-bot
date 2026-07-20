import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workspace = new URL("../../../", import.meta.url);

describe("Android device E2E scripts", () => {
  it("requires a newly persisted assistant response instead of matching history", async () => {
    const source = await read("scripts/android-chat-e2e.mjs");
    expect(source).toContain("assistantCountAfter");
    expect(source).toContain("assistants.length > assistantCountBefore");
    expect(source).not.toContain("document.body.innerText.includes(${JSON.stringify(expected)}")
  });

  it("covers HOME suspension, lifecycle ordering, partial discard, and recovery", async () => {
    const [source, rootPackage] = await Promise.all([
      read("scripts/android-chat-e2e.mjs"),
      read("package.json"),
    ]);
    expect(source).toContain("KEYCODE_HOME");
    expect(source).toContain('["suspending", "suspended"]');
    expect(source).toContain('["resuming", "active"]');
    expect(source).toContain("partialReplyDiscarded: true");
    expect(source).toContain("chatExpression(recoveryPrompt, expected)");
    expect(rootPackage).toContain('"android:e2e:lifecycle"');
    expect(rootPackage).toContain("--lifecycle");
  });

  it("supports a slow Provider and cleans owned ADB tunnels", async () => {
    const [client, provider] = await Promise.all([
      read("scripts/android-chat-e2e.mjs"),
      read("scripts/mock-openai-server.mjs"),
    ]);
    expect(provider).toContain("NKG_MOCK_CHUNK_DELAY_MS");
    expect(provider).toContain("connectionClosed");
    expect(client).toContain("cleanupAndroidForwarding");
    expect(client).toContain('forward", "--remove"');
    expect(client).toContain('reverse", "--remove"');
  });
});

async function read(path: string): Promise<string> {
  return readFile(new URL(path, workspace), "utf8");
}
