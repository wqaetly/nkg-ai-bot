import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "../src/MarkdownContent";
import { ReasoningPanel } from "../src/ReasoningPanel";

describe("chat response presentation", () => {
  it("renders GitHub-flavored Markdown without executing raw HTML", () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, {
      content: [
        "## 结果",
        "",
        "- [x] 已完成",
        "",
        "| 项目 | 状态 |",
        "| --- | --- |",
        "| 构建 | 通过 |",
        "",
        "<script>alert('unsafe')</script>",
      ].join("\n"),
    }));

    expect(html).toContain("<h2>结果</h2>");
    expect(html).toContain("type=\"checkbox\"");
    expect(html).toContain("<table>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("opens live reasoning and leaves completed reasoning collapsed", () => {
    const live = renderToStaticMarkup(createElement(ReasoningPanel, {
      reasoning: "正在分析",
      active: true,
    }));
    const completed = renderToStaticMarkup(createElement(ReasoningPanel, {
      reasoning: "分析完成",
    }));

    expect(live).toContain("<details class=\"reasoning-panel active\" open=\"\"");
    expect(live).toContain("正在深度思考");
    expect(completed).toContain("<details class=\"reasoning-panel\"");
    expect(completed).not.toContain(" open=\"\"");
    expect(completed).toContain("点击展开");
  });
});
