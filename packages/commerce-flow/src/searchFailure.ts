export class SearchResponseError extends Error {
  constructor(readonly code: "invalid_response" | "upstream_unavailable" | "no_results", message: string) {
    super(message);
    this.name = "SearchResponseError";
  }
}

/** Never echo raw upstream errors: they may contain request URLs or credentials. */
export function checkSearchResponse(payload: unknown): void {
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  if (!Array.isArray(body.results)) {
    throw new SearchResponseError("invalid_response", "搜索服务返回格式异常，缺少结果列表，请检查服务配置。");
  }
  if (body.results.length) return;
  const failures = Array.isArray(body.unresponsive_engines) ? body.unresponsive_engines : [];
  if (failures.length) {
    const reasons = failures.flatMap((row) => Array.isArray(row) && typeof row[1] === "string" ? [row[1]] : []).join(" ");
    const categories = [
      /captcha|验证码/i.test(reasons) ? "验证码" : "",
      /too many|rate.?limit|请求过于频繁/i.test(reasons) ? "限流" : "",
      /timeout|timed out|超时/i.test(reasons) ? "超时" : "",
    ].filter(Boolean);
    throw new SearchResponseError("upstream_unavailable", `搜索上游暂不可用${categories.length ? `（${categories.join("、")}）` : ""}，未获得联网资料。请待服务恢复后重试，或在设置中切换搜索服务。`);
  }
  throw new SearchResponseError("no_results", "本轮关键词没有找到可用网页，可以缩短关键词后重试。");
}
