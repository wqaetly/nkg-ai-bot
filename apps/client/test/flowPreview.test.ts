import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FlowPreviewGraph } from "@ai-native-flow/studio/flowPreview";
import { deriveRuntimeDebugNodeState } from "@ai-native-flow/studio/runtimeDebug";
import { FlowPreviewPanel } from "../src/FlowPreviewPanel";

const graph = {
  id: "preview_test",
  version: "1.0.0",
  schemaVersion: "flow.graph.v1",
  label: "预览测试",
  nodes: [
    {
      id: "start",
      type: "start",
      typeVersion: "1.0.0",
      position: { x: 0, y: 0 },
      ports: [{ id: "out", direction: "output", kind: "control" }],
      config: {},
    },
    {
      id: "end",
      type: "end",
      typeVersion: "1.0.0",
      position: { x: 320, y: 0 },
      ports: [{ id: "in", direction: "input", kind: "control" }],
      config: {},
    },
  ],
  edges: [
    {
      id: "start-end",
      from: { nodeId: "start", portId: "out" },
      to: { nodeId: "end", portId: "in" },
    },
  ],
} as FlowPreviewGraph;

describe("chat Flow preview", () => {
  it("renders collapsed by default and describes the real graph", () => {
    const html = renderToStaticMarkup(createElement(FlowPreviewPanel, {
      graph,
      name: "预览测试",
    }));

    expect(html).toContain("<details class=\"flow-preview-panel\"");
    expect(html).not.toContain(" open=");
    expect(html).toContain("执行流程");
    expect(html).toContain("预览测试 · 2 个节点");
    expect(html).not.toContain("react-flow");
  });

  it("maps runtime lifecycle events to node states", () => {
    const events = [
      { kind: "node_started", nodeId: "start", timestamp: "2026-07-23T10:00:00.000Z", payload: {} },
      { kind: "node_finished", nodeId: "start", timestamp: "2026-07-23T10:00:00.125Z", payload: { durationMs: 125 } },
      { kind: "node_started", nodeId: "end", timestamp: "2026-07-23T10:00:00.126Z", payload: {} },
      { kind: "node_error", nodeId: "end", timestamp: "2026-07-23T10:00:00.140Z", payload: {} },
    ];

    expect(deriveRuntimeDebugNodeState(events, "start")).toEqual({
      status: "succeeded",
      runtime: { startedAt: 1784800800000, durationMs: 125 },
    });
    expect(deriveRuntimeDebugNodeState(events, "end").status).toBe("failed");
  });
});
