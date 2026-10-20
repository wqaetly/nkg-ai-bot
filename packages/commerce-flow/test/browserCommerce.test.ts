import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { createBrowserCommerceNode, directProductUrl, normalizeBrowserProducts, productPurchaseUrl } from "../src/browserCommerce.js";
import { guardComputerBlueprintV4, makeComputerQuery, normalizeComputerRequirementV4, verifyComputerCandidateV4 } from "../src/computerAdvisorV4.js";
import type { AffiliateProduct } from "../src/commerce.js";

describe("direct marketplace product boundaries", () => {
  it.each([
    ["jd", "https://item.jd.com/123.html?tracking=secret", "https://item.jd.com/123.html"],
    ["pdd", "https://mobile.yangkeduo.com/goods.html?goods_id=123&share=abc", "https://mobile.yangkeduo.com/goods.html?goods_id=123"],
    ["taobao", "https://detail.tmall.com/item.htm?id=123&spm=abc", "https://detail.tmall.com/item.htm?id=123"],
  ] as const)("keeps only the %s product identity in shared links", (provider, raw, expected) => {
    expect(directProductUrl(provider, raw)).toBe(expected);
  });
  it.each([
    "https://item.jd.com.evil.test/123.html", "javascript:alert(1)", "https://127.0.0.1/123.html",
    "https://item.jd.com@evil.test/123.html", "https://search.jd.com/Search?keyword=cpu", "https://item.jd.com:444/123.html",
  ])("rejects unsafe or non-product addresses: %s", (url) => expect(directProductUrl("jd", url)).toBeUndefined());
  it("requires a successful detail visit and rejects invalid prices", () => {
    const raw = [{ title: "RTX 4060 显卡", price: 2999, url: "https://item.jd.com/123.html" }];
    expect(productPurchaseUrl(normalizeBrowserProducts(raw, "jd")[0]!)).toBeUndefined();
    expect(productPurchaseUrl(normalizeBrowserProducts(raw, "jd", true)[0]!)).toBe(raw[0]!.url);
    expect(normalizeBrowserProducts([...raw, { ...raw[0], price: Infinity }, { ...raw[0], price: -1 }], "jd", true)).toHaveLength(1);
  });
});

const collector = readFileSync(new URL("../src/browserCollector.js", import.meta.url), "utf8");

function pageHarness(provider: string, payload: unknown, options: { url?: string; text?: string; elapsed?: number; stateKey?: string; script?: string } = {}) {
  let tick = () => {};
  let now = 0;
  const pageUrl = new URL(options.url ?? "https://search.jd.com/Search?keyword=4060");
  const location = { href: pageUrl.href, hostname: pageUrl.hostname, pathname: pageUrl.pathname };
  const window: Record<string, unknown> = {
    [options.stateKey ?? "rawData"]: payload,
    fetch: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
  };
  window.top = window;
  class FakeXHR {
    onLoad = () => {};
    send() {}
    addEventListener(_event: string, callback: () => void) { this.onLoad = callback; }
  }
  class FakeNode { appendChild(child: unknown) { return child; } insertBefore(child: unknown) { return child; } }
  const context = vm.createContext({
    window, location, XMLHttpRequest: FakeXHR, Node: FakeNode, URL, Map, Set, JSON,
    Date: { now: () => now },
    document: { body: { innerText: options.text ?? "商品详情" }, querySelectorAll: () => [], querySelector: () => null },
    setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {},
  });
  vm.runInContext(collector, context);
  vm.runInContext(`collectCommercePage(${JSON.stringify({ provider, url: options.url, callback: "https://nkg-commerce.invalid/test" })})`, context);
  if (options.script) vm.runInContext(options.script, context);
  now = options.elapsed ?? 4000;
  tick();
  now += 701;
  tick();
  return JSON.parse(new URL(location.href).searchParams.get("data") ?? "null");
}

describe("marketplace page collector", () => {
  it("keeps the bounded search pool for ranking instead of truncating to the first eight cards", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ itemId: String(i + 1), title: i === 15 ? "微星 PRO B650M-P 主板" : "其他商品主板", price: 699 }));
    const result = pageHarness("taobao", { data: { itemsArray: rows } });
    expect(result.products).toHaveLength(20);
    expect(result.products).toContainEqual(expect.objectContaining({ title: "微星 PRO B650M-P 主板" }));
  });
  it("does not treat a login link beside loaded products as a login gate", () => {
    expect(pageHarness("jd", { skuId: "123", skuName: "RTX 4060 显卡", price: 2999 }, {
      text: "扫码登录 RTX 4060 显卡", elapsed: 14000,
    })).toMatchObject({ status: "ok" });
  });
  it("waits for product data instead of declaring login required on the first tick", () => {
    expect(pageHarness("jd", {}, { text: "扫码登录", elapsed: 700 })).toBeNull();
  });
  it("still recognizes an actual login page even with stale product data", () => {
    expect(pageHarness("jd", { skuId: "123", skuName: "RTX 4060 显卡", price: 2999 }, {
      url: "https://passport.jd.com/new/login.aspx", elapsed: 700,
    })).toMatchObject({ status: "login_required", products: [] });
  });
  it.each([
    ["pdd", { goods_id: "123", goods_name: "RTX 4060 8GB 显卡", min_group_price: 299900 }, "https://mobile.yangkeduo.com/goods.html?goods_id=123"],
    ["jd", { skuId: "123", skuName: "RTX 4060 8GB 显卡", price: "2999" }, "https://item.jd.com/123.html"],
    ["taobao", { nid: "123", raw_title: "RTX 4060 8GB 显卡", view_price: "2999.00", detail_url: "//item.taobao.com/item.htm?id=123" }, "https://item.taobao.com/item.htm?id=123"],
  ])("extracts bounded %s product data without exporting session fields", (provider, row, url) => {
    const result = pageHarness(String(provider), { data: [row], token: "do-not-export", cookie: "private" });
    expect(result.status).toBe("ok");
    expect(result.products).toEqual([expect.objectContaining({ url, price: 2999 })]);
    expect(JSON.stringify(result)).not.toMatch(/do-not-export|private/);
  });
  it("does not confuse recommendations on a detail page with the requested product", () => {
    const result = pageHarness("jd", { data: [
      { skuId: "123", skuName: "RTX 4060 8GB 显卡", price: 2999 },
      { skuId: "456", skuName: "RTX 4090 24GB 显卡", price: 12999 },
    ] }, { url: "https://item.jd.com/123.html" });
    expect(result.products).toHaveLength(1);
    expect(result.products[0].url).toBe("https://item.jd.com/123.html");
  });
  it.each([
    ["请先登录", "login_required"], ["请完成验证", "verification_required"],
    ["没有找到相关商品", "empty"], ["商品已下架", "unavailable"], ["页面内容已经改变", "parser_unmatched"],
  ])("distinguishes %s from empty inventory", (text, status) => {
    expect(pageHarness("jd", {}, { text, elapsed: 22000 })).toMatchObject({ status, products: [] });
  });

  it("joins Taobao SSR identity with sibling SKU pricing", () => {
    const result = pageHarness("taobao", { loaderData: { home: { data: { res: {
      item: { itemId: "123", title: "AMD 7500F 处理器" },
      skuCore: { sku2info: { "0": { price: { priceText: "899.99" } } } },
    } } } } }, { stateKey: "__ICE_APP_CONTEXT__", url: "https://item.taobao.com/item.htm?id=123&token=private" });
    expect(result.products).toEqual([expect.objectContaining({ title: "AMD 7500F 处理器", price: 899.99 })]);
    expect(result.diagnostics).toMatchObject({ pageUrl: "https://item.taobao.com/item.htm", shapes: expect.arrayContaining(["item", "skuCore"]) });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("decodes detail apiStack JSON without evaluating scripts or choosing a price-range minimum", () => {
    const item = { itemId: "123", title: "AMD 7500F 处理器" };
    const wrap = (price: string) => ({ item, apiStack: [{ value: JSON.stringify({ price: { price: { priceText: price } } }) }] });
    expect(pageHarness("taobao", wrap("899.99"), { url: "https://item.taobao.com/item.htm?id=123" }).products[0].price).toBe(899.99);
    expect(pageHarness("taobao", wrap("899-1299"), { url: "https://item.taobao.com/item.htm?id=123", elapsed: 22000 })).toMatchObject({ status: "parser_unmatched", products: [] });
  });

  it.each([false, true])("observes JSONP when the callback is assigned after insertion: %s", (late) => {
    const assign = `window.mtopjsonp1 = function (value) { window.applicationCallback = value; };`;
    const data = { data: { itemsArray: [{ itemId: "123", title: "AMD 7500F 处理器", priceShow: "899.99", auctionURL: "//item.taobao.com/item.htm?id=123" }] } };
    const result = pageHarness("taobao", {}, { script: `
      ${late ? "" : assign}
      new Node().appendChild({tagName: "SCRIPT", src: "https://h5api.m.taobao.com/h5/mtop.recommend/1.0/?callback=mtopjsonp1&sign=PRIVATE", querySelectorAll: () => []});
      ${late ? assign : ""}
      window.mtopjsonp1(${JSON.stringify(data)});
      if (!window.applicationCallback) throw new Error("original callback lost");
    ` });
    expect(result.products[0]).toMatchObject({ price: 899.99 });
    expect(result.diagnostics).toMatchObject({ jsonp: 1, responses: 1 });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("retains unpriced search identities for a subsequent detail visit", () => {
    expect(pageHarness("taobao", { data: { itemsArray: [{ itemId: "123", title: "AMD 7500F 处理器" }] } }))
      .toMatchObject({ status: "ok", products: [{ price: null, url: "https://item.taobao.com/item.htm?id=123" }] });
  });

  it("observes JD product actions whose operation name is in functionId", () => {
    const result = pageHarness("jd", {}, { script: `
      const xhr = new XMLHttpRequest();
      xhr.responseURL = "https://api.m.jd.com/client.action?functionId=pc_search&token=PRIVATE";
      xhr.responseType = "text";
      xhr.responseText = JSON.stringify({data:{skuId:"123",skuName:"AMD 7500F 处理器",price:"899.99"}});
      xhr.send(); xhr.onLoad();
    ` });
    expect(result.products[0]).toMatchObject({ price: 899.99 });
    expect(result.diagnostics).toMatchObject({ responses: 1, sources: ["https://api.m.jd.com/client.action"] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("recognizes API risk responses instead of reporting a parser failure", () => {
    expect(pageHarness("taobao", { ret: ["FAIL_SYS_USER_VALIDATE::private verification URL"] }, { elapsed: 22000 }))
      .toMatchObject({ status: "verification_required", products: [] });
  });

  it.each([
    ["mtop.alibaba.detail.getaddresslist", "FAIL_SYS_SESSION_EXPIRED"],
    ["mtop.relationrecommend.wirelessrecommend.recommend", "FAIL_SYS_USER_VALIDATE"],
    ["mtop.taobao.pcdetail.data.get", "FAIL_SYS_TOKEN_EMPTY"],
    ["mtop.taobao.pcdetail.data.get", "FAIL_SYS_TOKEN_EXPIRED"],
  ])("does not stop a detail page for %s / %s", (api, ret) => {
    const script = `
      window.mtopjsonp1 = () => {};
      new Node().appendChild({tagName:"SCRIPT",src:"https://h5api.m.tmall.com/h5/${api}/1.0/?callback=mtopjsonp1",querySelectorAll:()=>[]});
      window.mtopjsonp1({ret:["${ret}"]});
    `;
    expect(pageHarness("taobao", {}, { url: "https://detail.tmall.com/item.htm?id=123", elapsed: 700, script })).toBeNull();
    expect(pageHarness("taobao", { item: { itemId: "123", title: "利民 AX120R SE 散热器" },
      skuCore: { sku2info: { "0": { price: { priceText: "70" } } } } }, {
      url: "https://detail.tmall.com/item.htm?id=123", script,
    })).toMatchObject({ status: "ok", products: [{ price: 70 }] });
  });

  it.each([
    ["FAIL_SYS_SESSION_EXPIRED", "login_required"],
    ["FAIL_SYS_USER_VALIDATE", "verification_required"],
  ])("still honors a primary product API gate: %s", (ret, status) => {
    expect(pageHarness("taobao", {}, { url: "https://detail.tmall.com/item.htm?id=123", elapsed: 700, script: `
      const xhr = new XMLHttpRequest();
      xhr.responseURL = "https://h5api.m.tmall.com/h5/mtop.taobao.pcdetail.data.get/1.0/";
      xhr.responseType = "json"; xhr.response = {ret:["${ret}"]}; xhr.send(); xhr.onLoad();
    ` })).toMatchObject({ status, products: [] });
  });
});

describe("browser collection failure diagnostics", () => {
  it.each(["search", "detail"])("records the failing %s phase without response secrets", async (phase) => {
    let calls = 0;
    const node = createBrowserCommerceNode(async () => {
      const successfulSearch = phase === "detail" && calls++ === 0;
      return new Response(JSON.stringify(successfulSearch ? {
        status: "ok", products: [{ title: "AMD 7500F 处理器", url: "https://item.taobao.com/item.htm?id=123", price: null }],
      } : { status: "parser_unmatched", products: [], diagnostics: {
        pageUrl: "https://item.taobao.com/item.htm?id=123&token=PRIVATE",
        responses: 2, missingPrice: 3, cookie: "PRIVATE",
        sources: ["https://h5api.m.taobao.com/h5/mtop.detail/1.0/?sign=PRIVATE"],
        shapes: ["item", "PRIVATE"],
      } }));
    });
    const context = { signal: new AbortController().signal, variables: { getString: () => "taobao" } } as Parameters<typeof node.runner>[1];
    const result = await node.runner({ plan: { queries: [{ keyword: "7500F" }] } }, context);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.outputs.products).toEqual([]);
    expect(result.outputs.telemetry).toEqual([expect.objectContaining({
      provider: "taobao", acceptedCount: 0,
      browserPages: expect.arrayContaining([expect.objectContaining({ phase, status: "parser_unmatched", responses: 2 })]),
    })]);
    expect(JSON.stringify(result.outputs.telemetry)).not.toContain("PRIVATE");
    if (phase === "search") expect(JSON.stringify(result.outputs.errors)).toContain("搜索页");
    else {
      expect(result.outputs.errors).toEqual([]);
      expect(result.outputs.telemetry).toEqual([expect.objectContaining({ browserCandidates: [expect.objectContaining({ outcome: "detail_unresolved" })] })]);
    }
  });
});

describe("search titles rank candidates instead of rejecting them", () => {
  const requirements = normalizeComputerRequirementV4({ intent: "parts", targetParts: ["motherboard"] }, "推荐微星主板").requirements;
  const slot = guardComputerBlueprintV4({ slots: [{ partType: "motherboard", primaryModel: "微星 PRO B650M-P",
    requiredSpecs: { socket: "AM5", memoryType: "DDR5" } }] }, requirements).state.blueprint.slots[0]!;
  const query = makeComputerQuery(slot, "exact_model", 1)!;
  const row = (id: number, title: string, price: number | null = null) => ({ title, price, url: `https://item.taobao.com/item.htm?id=${id}` });
  const context = () => ({ signal: new AbortController().signal, variables: { getString: () => "taobao" } });

  it.each([
    "微星 PRO B650M-P / A620M-E 主板",
    "微星 PRO B650M-P 主板 非二手 含原装挡板",
    "微星 PRO B650M-P 主板 支持独立显卡",
    "PRO B650M-P 主板", // The search card may omit the brand.
  ])("visits and verifies details despite a misleading card: %s", async (title) => {
    const calls: Record<string, string>[] = [];
    const node = createBrowserCommerceNode(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); calls.push(body);
      return Response.json({ status: "ok", products: [body.url
        ? row(123, "微星 PRO B650M-P AM5 DDR5 主板", 699) : row(123, title)] });
    });
    const result = await node.runner({ plan: { queries: [query] } }, context() as Parameters<typeof node.runner>[1]);
    expect(calls).toHaveLength(2);
    if (result.kind !== "success") throw new Error("collection failed");
    const product = (result.outputs.products as AffiliateProduct[])[0]!;
    expect(verifyComputerCandidateV4({ slot, query, product })).toMatchObject({ comparablePrice: 699 });
    expect(result.outputs.telemetry).toEqual([expect.objectContaining({ rejectedByModel: 0, browserCandidates: [expect.objectContaining({ title, outcome: "detail_priced" })] })]);
  });

  it("does not turn unresolved mixed-model detail prices into a valid quote", async () => {
    const node = createBrowserCommerceNode(async () => Response.json({ status: "ok", products: [row(123, "微星 PRO B650M-P / A620M-E 主板", 499)] }));
    const result = await node.runner({ plan: { queries: [query] } }, context() as Parameters<typeof node.runner>[1]);
    if (result.kind !== "success") throw new Error("collection failed");
    expect(verifyComputerCandidateV4({ slot, query, product: (result.outputs.products as AffiliateProduct[])[0]! }))
      .toMatchObject({ reasons: expect.arrayContaining(["ambiguous_model_price"]) });
  });

  it("ranks matching models ahead of unrelated cards and continues after an unresolved detail", async () => {
    const visits: string[] = [];
    const node = createBrowserCommerceNode(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (!body.url) return Response.json({ status: "ok", products: [
        row(1, "电脑主板配件"), row(2, "电脑主板配件"), row(3, "电脑主板配件"),
        row(4, "微星 PRO B650M-P / A620M-E 主板"), row(5, "微星 PRO B650M-P 主板"),
      ] });
      visits.push(body.url);
      return Response.json(visits.length === 1 ? { status: "parser_unmatched", products: [] }
        : { status: "ok", products: [row(Number(new URL(body.url).searchParams.get("id")), "微星 PRO B650M-P AM5 DDR5 主板", 699)] });
    });
    const result = await node.runner({ plan: { queries: [query] } }, context() as Parameters<typeof node.runner>[1]);
    expect(visits).toHaveLength(4);
    expect(visits.slice(0, 2)).toEqual([row(5, "").url, row(4, "").url]);
    if (result.kind !== "success") throw new Error("collection failed");
    expect(result.outputs.errors).toEqual([]);
    expect(result.outputs.telemetry).toEqual([expect.objectContaining({ rejectedByModel: 0,
      browserCandidates: expect.arrayContaining([
        expect.objectContaining({ productId: "5", outcome: "detail_unresolved" }),
        expect.objectContaining({ productId: "4", outcome: "detail_priced" }),
        expect.objectContaining({ outcome: "not_visited_budget" }),
      ]) })]);
  });

  it.each(["login_required", "verification_required"])("still stops on a real %s gate", async (status) => {
    let calls = 0;
    const node = createBrowserCommerceNode(async () => Response.json(++calls === 1
      ? { status: "ok", products: [row(1, "微星 PRO B650M-P 主板"), row(2, "微星 PRO B650M-P 主板")] }
      : { status, products: [] }));
    const result = await node.runner({ plan: { queries: [query] } }, context() as Parameters<typeof node.runner>[1]);
    expect(calls).toBe(2);
    if (result.kind !== "success") throw new Error("collection failed");
    expect(result.outputs.products).toEqual([]);
    expect(result.outputs.errors).toHaveLength(1);
  });
});
