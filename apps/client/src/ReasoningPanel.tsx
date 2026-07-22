import { MarkdownContent } from "./MarkdownContent";

export function ReasoningPanel({ reasoning, active = false }: { reasoning: string; active?: boolean }) {
  if (!reasoning.trim()) return null;
  return (
    <details className={`reasoning-panel${active ? " active" : ""}`} open={active || undefined}>
      <summary>
        <span className="reasoning-symbol" aria-hidden="true">✦</span>
        <span>{active ? "正在深度思考" : "深度思考"}</span>
        <small>{active ? "实时更新" : "点击展开"}</small>
        <span className="reasoning-chevron" aria-hidden="true">⌄</span>
      </summary>
      <MarkdownContent className="reasoning-content" content={reasoning} />
    </details>
  );
}
