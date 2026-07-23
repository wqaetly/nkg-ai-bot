import { lazy, Suspense, useState } from "react";
import type {
  FlowPreviewGraph,
  FlowPreviewRuntimeEvent,
} from "@ai-native-flow/studio/flowPreview";
import { deriveRuntimeDebugNodeState } from "@ai-native-flow/studio/runtimeDebug";

const FlowPreview = lazy(() => import("@ai-native-flow/studio/flowPreview").then((module) => ({
  default: module.FlowPreview,
})));

export function FlowPreviewPanel({
  graph,
  name,
  runtimeEvents = [],
  active = false,
}: {
  graph: FlowPreviewGraph;
  name: string;
  runtimeEvents?: ReadonlyArray<FlowPreviewRuntimeEvent>;
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const debugStates = graph.nodes.map((node) =>
    deriveRuntimeDebugNodeState(runtimeEvents, node.id),
  );
  const completedCount = debugStates.filter((state) => state.status === "succeeded").length;
  const failed = debugStates.some((state) => state.status === "failed");

  return (
    <details
      className={`flow-preview-panel${active ? " active" : ""}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="flow-preview-symbol" aria-hidden="true"><FlowIcon /></span>
        <span>{active ? "正在执行 Flow" : "执行流程"}</span>
        <small>
          {active
            ? failed
              ? "执行失败"
              : `${completedCount}/${graph.nodes.length} 个节点`
            : `${name} · ${graph.nodes.length} 个节点`}
        </small>
        <span className="flow-preview-chevron" aria-hidden="true">⌄</span>
      </summary>
      {open ? (
        <Suspense fallback={<div className="flow-preview-loading">正在加载流程图…</div>}>
          <FlowPreview
            ariaLabel={`${name} 执行流程`}
            graph={graph}
            runtimeEvents={runtimeEvents}
          />
        </Suspense>
      ) : null}
    </details>
  );
}

function FlowIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <rect height="5" rx="1.2" stroke="currentColor" strokeWidth="1.4" width="5" x="1.5" y="7.5" />
      <rect height="5" rx="1.2" stroke="currentColor" strokeWidth="1.4" width="5" x="13.5" y="2" />
      <rect height="5" rx="1.2" stroke="currentColor" strokeWidth="1.4" width="5" x="13.5" y="13" />
      <path d="M6.5 10h2.2c2.2 0 2.1-5.5 4.8-5.5M8.7 10c2.2 0 2.1 5.5 4.8 5.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  );
}
