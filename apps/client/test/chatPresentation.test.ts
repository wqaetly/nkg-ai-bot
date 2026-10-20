import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "../src/MarkdownContent";
import { ReasoningPanel } from "../src/ReasoningPanel";
import { SearchReferencesPanel } from "../src/SearchReferencesPanel";
import { ConversationFlowConfigDialog } from "../src/ConversationFlowConfigDialog";
import { COMPUTER_CONFIG_FLOW } from "../src/builtinFlows";
import { flowConfigurableVariables } from "../src/conversationFlowConfig";

describe("chat response presentation", () => {
  it("renders the marketplace selector and login action from the current computer Flow", () => {
    const html = renderToStaticMarkup(createElement(ConversationFlowConfigDialog, {
      flowName: "电脑配置顾问",
      definitions: flowConfigurableVariables(COMPUTER_CONFIG_FLOW),
      values: { COMPUTER_SHOPPING_PLATFORM: "jd" },
      onCancel: () => {},
      onSave: async () => {},
    }));
    expect(html).toContain("打开所选商城 / 登录");
    expect(html).toContain("拼多多");
    expect(html).toContain("淘宝");
    expect(html).toContain('<option value="string:jd" selected="">京东</option>');
  });

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

  it("renders web references collapsed by default", () => {
    const html = renderToStaticMarkup(createElement(SearchReferencesPanel, {
      references: [{
        title: "Release notes",
        url: "https://www.example.test/releases/1",
        snippet: "Version 1 released.",
      }],
    }));

    expect(html).toContain("<details class=\"search-references-panel\"");
    expect(html).not.toContain(" open=\"\"");
    expect(html).toContain("联网搜索参考");
    expect(html).toContain("1 个网页");
    expect(html).toContain("example.test");
    expect(html).toContain("target=\"_blank\"");
  });
});
