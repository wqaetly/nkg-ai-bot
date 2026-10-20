/* Runs in an isolated marketplace WebView. Only normalized product fields leave the page. */
function collectCommercePage(config) {
  if (window.top !== window) return;
  const products = new Map();
  const platform = config.provider;
  const detailId = config.url ? identity(config.url) : null;
  let finished = false;
  const started = Date.now();
  let lastProductAt = started;
  let gate;
  let emptyList = false;
  let scrolls = 0;
  const detailPrices = new Map();
  const sources = new Set();
  const shapes = new Set();
  const counters = { responses: 0, jsonp: 0, parseErrors: 0, productLinks: 0, missingTitle: 0, missingPrice: 0, rejectedIdentity: 0 };
  const safeAddress = (raw) => {
    try { const u = new URL(raw, location.href); return /^https?:$/.test(u.protocol) ? `${u.origin}${u.pathname}`.slice(0, 240) : ""; }
    catch { return ""; }
  };
  const money = (value) => {
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
    if (typeof value !== "string") return null;
    const match = value.replace(/,/g, "").trim().match(/^(?:[¥￥]|人民币)?\s*(\d+(?:\.\d{1,2})?)\s*(?:元)?$/);
    return match && Number(match[1]) > 0 ? Number(match[1]) : null;
  };
  function identity(raw) {
    try {
      const url = new URL(raw, location.href);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return null;
      if (platform === "jd" && url.hostname === "item.jd.com" && /^\/\d+\.html$/.test(url.pathname)) {
        return { id: url.pathname.slice(1, -5), url: `https://item.jd.com${url.pathname}` };
      }
      if (platform === "pdd" && ["mobile.yangkeduo.com", "mobile.pinduoduo.com"].includes(url.hostname)
        && url.pathname === "/goods.html" && /^\d+$/.test(url.searchParams.get("goods_id") || "")) {
        return { id: url.searchParams.get("goods_id"), url: `https://mobile.yangkeduo.com/goods.html?goods_id=${url.searchParams.get("goods_id")}` };
      }
      if (platform === "taobao" && ["item.taobao.com", "detail.tmall.com"].includes(url.hostname)
        && url.pathname === "/item.htm" && /^\d+$/.test(url.searchParams.get("id") || "")) {
        return { id: url.searchParams.get("id"), url: `https://${url.hostname}/item.htm?id=${url.searchParams.get("id")}` };
      }
    } catch { /* Ignore non-product links. */ }
    return null;
  }
  function add(row) {
    const link = identity(row.url);
    const price = money(row.price);
    if (!link) { counters.rejectedIdentity++; return; }
    if (typeof row.title !== "string" || row.title.trim().length < 4) { counters.missingTitle++; return; }
    if (!price) { counters.missingPrice++; if (detailId) return; }
    if (detailId && (link.id !== detailId.id || identity(location.href)?.id !== detailId.id)) { counters.rejectedIdentity++; return; }
    if (products.size >= 20 && !products.has(link.id)) return;
    if (!price && products.get(link.id)?.price) return;
    if (!products.has(link.id) || products.get(link.id).price !== price) lastProductAt = Date.now();
    products.set(link.id, { title: row.title.replace(/<[^>]*>/g, "").trim().slice(0, 500),
      price, url: link.url, shopName: String(row.shopName || "").slice(0, 100),
      imageUrl: typeof row.imageUrl === "string" ? row.imageUrl.slice(0, 1500) : "" });
  }
  function readPayload(root) {
    if (finished) return;
    let visited = 0;
    const seen = new Set();
    const unpack = (value) => {
      if (typeof value !== "string" || value.length > 2_000_000 || !/^[\s]*[\[{]/.test(value)) return value;
      try { return JSON.parse(value); } catch { return null; }
    };
    function walk(value, depth) {
      if (!value || typeof value !== "object" || depth > 14 || ++visited > 12000 || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) { value.slice(0, 100).forEach((item) => walk(item, depth + 1)); return; }
      for (const key of ["itemsArray", "auctions", "resultList", "goods_list", "item", "skuCore", "apiStack", "goods", "price"]) {
        if (key in value) shapes.add(key);
        if (!detailId && ["itemsArray", "auctions", "resultList", "goods_list"].includes(key)
          && Array.isArray(value[key]) && value[key].length === 0) emptyList = true;
      }
      const ret = Array.isArray(value.ret) ? value.ret.join(" ") : "";
      if (/FAIL_SYS_USER_VALIDATE|RGV587|CAPTCHA|USER_VALIDATE/.test(ret)) gate = "verification_required";
      // A transport token failure alone does not prove the user's login session expired.
      else if (/FAIL_SYS_SESSION_EXPIRED|NEED_LOGIN/.test(ret)) gate ??= "login_required";

      // Taobao detail responses keep identity and SKU pricing in sibling objects (sometimes JSON strings).
      if (platform === "taobao" && value.item?.itemId && value.item?.title) {
        const stack = unpack(value.apiStack?.[0]?.value);
        const price = value.skuCore?.sku2info?.["0"]?.price?.priceText
          ?? stack?.skuCore?.sku2info?.["0"]?.price?.priceText
          ?? value.price?.price?.priceText ?? stack?.price?.price?.priceText;
        const id = String(value.item.itemId);
        add({ title: value.item.title, price,
          url: detailId?.id === id ? detailId.url : `https://item.taobao.com/item.htm?id=${id}`,
          shopName: value.seller?.shopName, imageUrl: value.item.images?.[0] });
      }
      const title = value.goods_name || value.goodsName || value.raw_title || value.title || value.name || value.skuName;
      const id = value.goods_id || value.goodsId || value.itemId || value.nid || value.skuId
        || (platform === "jd" && /^J_\d+$/.test(value.id || "") ? value.id.slice(2) : undefined);
      let url = value.detail_url || value.detailUrl || value.itemUrl || value.url || value.auctionURL;
      if (!identity(url) && /^\d+$/.test(String(id || ""))) {
        url = platform === "pdd" ? `https://mobile.yangkeduo.com/goods.html?goods_id=${id}`
          : platform === "jd" ? `https://item.jd.com/${id}.html` : `https://item.taobao.com/item.htm?id=${id}`;
      }
      if (identity(url)) {
        let price = value.view_price ?? value.price?.priceText ?? value.price?.price ?? value.price
          ?? value.priceShow?.price ?? value.priceShow ?? value.salePrice ?? value.offers?.price ?? value.p;
        if (platform === "pdd") {
          const cents = value.min_group_price ?? value.minGroupPrice ?? value.group?.[0]?.price;
          if (money(cents)) price = Number(cents) / 100;
        }
        if (detailId && identity(url).id === detailId.id && money(price)) detailPrices.set(detailId.id, money(price));
        if (typeof title === "string") add({ title, price, url, shopName: value.shopName || value.nick || value.mall_name,
          imageUrl: value.pic_url || value.picPath || value.image || value.goods_image_url });
      }
      Object.entries(value).forEach(([key, item]) => walk(["data", "value", "mockData"].includes(key) ? unpack(item) : item, depth + 1));
    }
    walk(root, 0);
  }
  function productEndpoint(raw) {
    try {
      const u = new URL(raw, location.href);
      const domains = platform === "taobao" ? ["taobao.com", "tmall.com"]
        : platform === "jd" ? ["jd.com", "3.cn"] : ["yangkeduo.com", "pinduoduo.com"];
      const operation = u.pathname + (u.searchParams.get("api") || "") + (u.searchParams.get("functionId") || "");
      // Auxiliary API login requirements say nothing about the product page's availability.
      if (/address|logistic|delivery|cart|favorite|review|comment/i.test(operation)
        || (detailId && /recommend/i.test(operation))) return false;
      return domains.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`))
        && /search|detail|recommend|goods|item|sku|price/i.test(operation);
    } catch { return false; }
  }
  function responsePayload(payload, address, jsonp = false) {
    if (finished) return;
    counters.responses++;
    if (jsonp) counters.jsonp++;
    if (sources.size < 8) sources.add(safeAddress(address));
    readPayload(payload);
  }
  function responseText(text, address) {
    if (typeof text !== "string" || text.length > 2_000_000) return;
    try {
      const wrapped = text.trim().match(/^[\w$.]+\s*\(([\s\S]*)\)\s*;?$/);
      responsePayload(JSON.parse(wrapped ? wrapped[1] : text), address, Boolean(wrapped));
    } catch { counters.parseErrors++; }
  }
  // Observe only responses already requested by the page; do not reconstruct private API signatures.
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const address = response.url || String(args[0]?.url || args[0]);
    if (productEndpoint(address)) {
      response.clone().text().then((text) => {
        responseText(text, address);
      }).catch(() => {});
    }
    return response;
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        if (!productEndpoint(this.responseURL)) return;
        if (this.responseType === "json") responsePayload(this.response, this.responseURL);
        else if (!this.responseType || this.responseType === "text") {
          responseText(this.responseText, this.responseURL);
        }
      } catch {}
    }, { once: true });
    return originalSend.apply(this, args);
  };
  // JSONP loads through script tags, so fetch/XHR hooks alone miss these product responses.
  const wrappedCallbacks = new WeakSet();
  function watchScript(script) {
    if (script?.tagName !== "SCRIPT" || !productEndpoint(script.src)) return;
    const u = new URL(script.src, location.href);
    const name = u.searchParams.get("callback") || u.searchParams.get("jsonp");
    if (!name || !/^[A-Za-z_$][\w$]*$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) return;
    const wrap = (callback) => {
      if (typeof callback !== "function" || wrappedCallbacks.has(callback)) return callback;
      const wrapped = function (...args) {
        try { responsePayload(args[0], script.src, true); } catch {}
        return callback.apply(this, args);
      };
      wrappedCallbacks.add(wrapped);
      return wrapped;
    };
    try {
      const descriptor = Object.getOwnPropertyDescriptor(window, name);
      if (descriptor && !descriptor.configurable) {
        if (descriptor.writable) window[name] = wrap(window[name]);
      } else {
        let callback = wrap(window[name]);
        Object.defineProperty(window, name, { configurable: true, enumerable: descriptor?.enumerable ?? true,
          get: () => callback, set: (value) => { callback = wrap(value); } });
      }
    } catch {}
  }
  if (typeof Node !== "undefined") {
    for (const method of ["appendChild", "insertBefore"]) {
      const original = Node.prototype[method];
      Node.prototype[method] = function (child, ...args) {
        try { watchScript(child); child?.querySelectorAll?.("script[src]").forEach(watchScript); } catch {}
        return original.call(this, child, ...args);
      };
    }
  }
  function domProducts() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"], script[type="application/json"]')) {
      if (script.textContent.length < 2_000_000) { try { readPayload(JSON.parse(script.textContent)); } catch {} }
    }
    for (const key of ["rawData", "__NEXT_DATA__", "g_page_config", "__ICE_APP_CONTEXT__", "__INITIAL_STATE__", "_DATA_Detail", "__INIT_DATA__"]) {
      try { if (window[key]) readPayload(window[key]); } catch {}
    }
    document.querySelectorAll("script[src]").forEach(watchScript);
    // Include card containers whose product link and price are siblings (JD data-sku, Taobao cards).
    const cards = document.querySelectorAll('[data-sku], [data-item-id], [data-nid], [class*="Card--doubleCardWrapper"], [class*="doubleCardWrapper"]');
    for (const card of [...cards].slice(0, 100)) {
      const ids = [...card.querySelectorAll("a[href]")].map((a) => identity(a.href)).filter(Boolean);
      const id = card.getAttribute("data-sku") || card.getAttribute("data-item-id") || card.getAttribute("data-nid");
      const link = ids[0] || (/^\d+$/.test(id || "") ? identity(platform === "jd" ? `https://item.jd.com/${id}.html`
        : platform === "taobao" ? `https://item.taobao.com/item.htm?id=${id}` : `https://mobile.yangkeduo.com/goods.html?goods_id=${id}`) : null);
      if (!link || new Set(ids.map((x) => x.id)).size > 1) continue;
      const title = card.querySelector('.p-name em, [class*="Title--title"], [class*="title--"], [class*="title"]')?.textContent
        || card.querySelector('img[alt]')?.getAttribute("alt");
      add({ title, price: cardPrice(card), url: link.url });
    }
    counters.productLinks = 0;
    for (const anchor of [...document.querySelectorAll("a[href]")].slice(0, 1500)) {
      if (!identity(anchor.href)) continue;
      counters.productLinks++;
      let card = anchor;
      for (let depth = 0; card && depth < 5; depth++, card = card.parentElement) {
        const links = [...card.querySelectorAll("a[href]")].map((a) => identity(a.href)?.id).filter(Boolean);
        if (new Set(links).size > 1) break;
        const text = card.innerText || "";
        const price = cardPrice(card);
        const title = anchor.getAttribute("title") || card.querySelector("[title]")?.getAttribute("title")
          || card.querySelector('.p-name em, [class*="Title--title"], [class*="title--"]')?.textContent
          || card.querySelector("img[alt]")?.getAttribute("alt") || anchor.innerText;
        if (title?.trim().length >= 4 && text.length < 2000) {
          add({ title, price, url: anchor.href, imageUrl: card.querySelector("img")?.src });
          if (price) break;
        }
      }
    }
    if (detailId && identity(location.href)?.id === detailId.id) {
      const title = document.querySelector('meta[property="og:title"]')?.content
        || document.querySelector('.sku-name, h1, [class*="ItemTitle"], [class*="mainTitle"]')?.textContent;
      const price = document.querySelector('meta[property="product:price:amount"], meta[itemprop="price"]')?.content
        || document.querySelector('.summary-price .p-price .price, .p-price .price, [class*="Price--priceText"], [class*="priceText"]')?.textContent
        || detailPrices.get(detailId.id);
      add({ title, price, url: location.href });
    }
  }
  function cardPrice(card) {
    const whole = card.querySelector('[class*="priceInt"]');
    const fraction = card.querySelector('[class*="priceFloat"], [class*="priceDecimal"]');
    if (whole) {
      const price = money(`${whole.textContent?.trim() || ""}${fraction?.textContent?.trim() || ""}`);
      if (price) return price;
    }
    const node = card.querySelector('.p-price i, [class*="Price--priceText"], [class*="priceText"], [class*="price--"]');
    return money(node?.textContent);
  }
  function finish(status) {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    const result = { status, products: status === "ok" ? [...products.values()] : [], diagnostics: {
      pageUrl: safeAddress(location.href), elapsedMs: Date.now() - started,
      readyState: document.readyState || "unknown", ...counters,
      productCount: products.size, sources: [...sources], shapes: [...shapes],
    } };
    // Navigation is intercepted and cancelled by the host. Remote pages receive no native IPC permissions.
    location.href = `${config.callback}?data=${encodeURIComponent(JSON.stringify(result))}`;
  }
  function tick() {
    if (finished || !document.body) return;
    const text = (document.body.innerText || "").slice(0, 3000);
    const path = location.hostname + location.pathname;
    if (gate) return finish(gate);
    if (/captcha|verify|risk|验证中心|安全验证|拖动滑块|请完成验证|访问过于频繁/i.test(path + text)) return finish("verification_required");
    if (/passport|login\.|\/login/i.test(path)) return finish("login_required");
    domProducts();
    if (gate) return finish(gate);
    if (products.size && Date.now() - started >= 3500 && Date.now() - lastProductAt >= 700) return finish("ok");
    if (Date.now() - started > (scrolls + 1) * 1800 && scrolls < 2 && !detailId) {
      window.scrollBy?.(0, 500); scrolls++;
    }
    // Login links can coexist with products; allow lazy content to load before declaring a gate.
    if (!products.size && Date.now() - started > 20000
      && /登录后(?:查看|继续|搜索)|请先登录|扫码登录|密码登录/.test(text)) return finish("login_required");
    if (/没有找到相关|暂无相关商品|未找到相关商品/.test(text)) return finish("empty");
    if (/商品已下架|商品不存在|宝贝不存在/.test(text)) return finish("unavailable");
    if (Date.now() - started > 20000) return finish(emptyList && !detailId ? "empty" : "parser_unmatched");
  }
  const timer = setInterval(tick, 700);
}
