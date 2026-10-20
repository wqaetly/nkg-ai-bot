import { describe, expect, it } from "vitest";
import { searchPublicMarket } from "../src/marketSearch.js";

describe("revision search failure classification", () => {
  it("preserves the real upstream failure instead of silently returning an empty market result", async () => {
    await expect(searchPublicMarket({ mode: "searxng", baseUrl: "https://example.test", authorization: "secret" }, "AM5 主板", 5,
      async () => Response.json({ results: [], unresponsive_engines: [["baidu", "暂停服务: 验证码"], ["brave", "请求过于频繁"]] })))
      .rejects.toMatchObject({ code: "upstream_unavailable", message: expect.stringContaining("验证码、限流") });
  });
});
