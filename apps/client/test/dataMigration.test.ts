import { describe, expect, it } from "vitest";
import {
  MIGRATION_FORMAT,
  MIGRATION_VERSION,
  parseMigrationBundle,
} from "../src/dataMigration";

function validBundle() {
  return {
    format: MIGRATION_FORMAT,
    version: MIGRATION_VERSION,
    exportedAt: "2026-07-22T12:00:00.000Z",
    counts: { conversations: 2, messages: 8, images: 1, skills: 3, memories: 4 },
    preferences: {
      "nkg.appearance.theme": "dark",
      "nkg.layout.sidebarCollapsed": "true",
      unrelated: "drop-me",
    },
    snapshot: {
      databaseHex: "00ff",
      vaultHex: "aabb",
      deviceKeyHex: "1122",
      strongholdSaltHex: "3344",
      chatImages: [{
        path: "chat-images/image-1.png",
        data: "AQID",
      }],
    },
  };
}

describe("data migration bundle", () => {
  it("validates a complete portable backup and keeps only app preferences", () => {
    const parsed = parseMigrationBundle(JSON.stringify(validBundle()));
    expect(parsed.counts).toEqual({ conversations: 2, messages: 8, images: 1, skills: 3, memories: 4 });
    expect(parsed.preferences).toEqual({
      "nkg.appearance.theme": "dark",
      "nkg.layout.sidebarCollapsed": "true",
    });
    expect(parsed.snapshot.deviceKeyHex).toBe("1122");
  });

  it("rejects corrupted encrypted credentials", () => {
    const bundle = validBundle();
    bundle.snapshot.deviceKeyHex = "not-hex";
    expect(() => parseMigrationBundle(JSON.stringify(bundle))).toThrow("设备密钥数据损坏");
  });

  it("rejects unsafe chat image paths", () => {
    const bundle = validBundle();
    bundle.snapshot.chatImages[0]!.path = "../secrets-auto.hold";
    expect(() => parseMigrationBundle(JSON.stringify(bundle))).toThrow("不安全的聊天图片路径");
  });

  it("rejects unsupported or unrelated files", () => {
    expect(() => parseMigrationBundle("not json")).toThrow("有效的 NKG 迁移文件");
    expect(() => parseMigrationBundle(JSON.stringify({ ...validBundle(), version: 9 }))).toThrow("暂不支持迁移包版本 9");
  });
});
