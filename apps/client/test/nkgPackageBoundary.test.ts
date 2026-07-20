import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const thisFile = fileURLToPath(import.meta.url);

describe("nkg-ai-flow package boundary", () => {
  it("consumes submodule code only through public package exports", () => {
    const forbiddenDeepImport = ["nkg-ai-flow", "packages"].join("/") + "/";
    const violations = sourceFiles([join(root, "apps"), join(root, "packages")])
      .filter((file) => file !== thisFile)
      .filter((file) => readFileSync(file, "utf8").includes(forbiddenDeepImport))
      .map((file) => relative(root, file).replaceAll("\\", "/"));

    expect(violations).toEqual([]);
  });

  it("links nkg packages into the application workspace lock", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

    expect(manifest.workspaces).toEqual(expect.arrayContaining([
      "nkg-ai-flow/packages/*",
      "nkg-ai-flow/packages/transports/*",
    ]));
    expect(lock.packages["nkg-ai-flow/packages/runtime"]).toMatchObject({
      name: "@ai-native-flow/runtime",
      version: "0.0.1",
    });
    expect(lock.packages["node_modules/@ai-native-flow/runtime"]).toMatchObject({
      resolved: "nkg-ai-flow/packages/runtime",
      link: true,
    });
  });

  it("uses the unified lockfile in every build workflow", () => {
    for (const workflow of ["mobile-build.yml", "desktop-sidecar.yml"]) {
      const contents = readFileSync(join(root, ".github", "workflows", workflow), "utf8");
      expect(contents).not.toContain("npm ci --prefix nkg-ai-flow");
      expect(contents).not.toContain("nkg-ai-flow/package-lock.json");
    }
  });
});

function sourceFiles(roots: string[]): string[] {
  const files: string[] = [];
  for (const rootPath of roots) visit(rootPath, files);
  return files;
}

function visit(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["dist", "node_modules", "src-tauri"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(path, files);
    } else if ([".ts", ".tsx", ".mjs"].includes(extname(entry.name))) {
      files.push(path);
    }
  }
}
