import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("mobile HTTP capability", () => {
  it("permits user-configured HTTP and HTTPS Provider ports", async () => {
    const path = new URL("../src-tauri/capabilities/default.json", import.meta.url);
    const capability = JSON.parse(await readFile(path, "utf8")) as {
      permissions: Array<string | { identifier: string; allow?: Array<{ url: string }> }>;
    };
    const http = capability.permissions.find(
      (permission): permission is { identifier: string; allow: Array<{ url: string }> } =>
        typeof permission === "object" && permission.identifier === "http:default" && Array.isArray(permission.allow),
    );

    const anyPort = ":*";
    expect(http?.allow.map((entry) => entry.url)).toEqual([
      `https://*${anyPort}`,
      `http://*${anyPort}`,
    ]);
  });
});
