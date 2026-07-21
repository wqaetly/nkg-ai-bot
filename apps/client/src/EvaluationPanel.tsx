import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppPlatform } from "@nkg-ai-bot/runtime-router";
import { getAssistantSkillVersion, listAssistantSkillIndex, type AssistantSkillIndex } from "./assistantSkills";
import { CandidateEvaluationRunner, nextPatchVersion, publishPassedCandidate, type EvaluationRuntime } from "./evaluation";
import {
  createArtifactCandidate,
  createEvalCase,
  deleteEvalCase,
  getEvalRun,
  listArtifactCandidates,
  listEvalCases,
  setArtifactCandidateStatus,
  setEvalCaseEnabled,
  type ArtifactCandidate,
  type EvalCase,
  type EvalRun,
} from "./evaluationRepository";

export function EvaluationPanel({
  onClose,
  onPublished,
  platform,
  runtime,
}: {
  onClose: () => void;
  onPublished: () => Promise<void>;
  platform: AppPlatform;
  runtime: EvaluationRuntime;
}) {
  const [skills, setSkills] = useState<AssistantSkillIndex[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [candidates, setCandidates] = useState<ArtifactCandidate[]>([]);
  const [runs, setRuns] = useState<Record<string, EvalRun>>({});
  const [caseInput, setCaseInput] = useState("");
  const [expected, setExpected] = useState("");
  const [promptDraft, setPromptDraft] = useState("");
  const [versionDraft, setVersionDraft] = useState("");
  const [rationale, setRationale] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState("");
  const selected = skills.find((skill) => skill.assistantId === selectedId) ?? skills[0];
  const runner = useMemo(() => new CandidateEvaluationRunner(runtime, platform), [runtime, platform]);

  const refresh = useCallback(async () => {
    const [skillRows, candidateRows] = await Promise.all([
      listAssistantSkillIndex(),
      listArtifactCandidates(),
    ]);
    setSkills(skillRows);
    setCandidates(candidateRows);
    setSelectedId((current) => current || skillRows[0]?.assistantId || "");
    const runRows = await Promise.all(candidateRows
      .filter((candidate) => candidate.latestEvalRunId)
      .map((candidate) => getEvalRun(candidate.latestEvalRunId!)));
    setRuns(Object.fromEntries(runRows.filter((run): run is EvalRun => Boolean(run)).map((run) => [run.id, run])));
  }, []);

  useEffect(() => {
    let active = true;
    refresh().catch((cause: unknown) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [refresh]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    listEvalCases(selected.assistantId, selected.activeVersion)
      .then((rows) => { if (active) setCases(rows); })
      .catch((cause: unknown) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [selected?.assistantId, selected?.activeVersion]);

  async function beginPromptCandidate() {
    if (!selected) return;
    setError("");
    try {
      const full = await getAssistantSkillVersion(selected.assistantId, selected.activeVersion);
      if (!full) throw new Error("Assistant 版本不存在");
      setPromptDraft(full.systemPrompt);
      setVersionDraft(nextPatchVersion(full.version));
      setRationale("");
      setEditorOpen(true);
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    }
  }

  async function savePromptCandidate() {
    if (!selected) return;
    setBusyId("new-candidate"); setError("");
    try {
      await createArtifactCandidate({
        kind: "assistant_prompt_patch",
        assistantId: selected.assistantId,
        baseVersion: selected.activeVersion,
        proposedVersion: versionDraft,
        proposal: { systemPrompt: promptDraft },
        rationale,
      });
      setEditorOpen(false);
      await refresh();
    } catch (cause: unknown) { setError(errorMessage(cause)); }
    finally { setBusyId(undefined); }
  }

  async function addGoldenCase() {
    if (!selected) return;
    setBusyId("new-case"); setError("");
    try {
      await createEvalCase({
        assistantId: selected.assistantId,
        assistantVersion: selected.activeVersion,
        input: caseInput,
        assertions: { mustContain: expected.split("\n").map((item) => item.trim()).filter(Boolean) },
        source: "golden",
      });
      setCaseInput(""); setExpected("");
      setCases(await listEvalCases(selected.assistantId, selected.activeVersion));
    } catch (cause: unknown) { setError(errorMessage(cause)); }
    finally { setBusyId(undefined); }
  }

  async function perform(candidate: ArtifactCandidate, action: () => Promise<void>) {
    setBusyId(candidate.id); setError("");
    try { await action(); await refresh(); await onPublished(); }
    catch (cause: unknown) { setError(errorMessage(cause)); }
    finally { setBusyId(undefined); }
  }

  const visibleCandidates = candidates.filter((item) => item.assistantId === selected?.assistantId);
  return (
    <div className="evaluation-content">
      <header className="settings-header">
        <div><span className="settings-kicker">LOCAL EVALUATION</span><h2>评测与发布</h2><p>候选先在冻结用例上与当前版本对比；通过全部硬门禁后才能由你手动发布。</p></div>
        <button aria-label="关闭评测与发布" className="icon-button" type="button" onClick={onClose}><CloseIcon /></button>
      </header>
      {error ? <p className="form-message error" role="alert">{error}</p> : null}
      <label className="eval-skill-picker">评测对象
        <select value={selected?.assistantId ?? ""} onChange={(event) => setSelectedId(event.currentTarget.value)}>
          {skills.map((skill) => <option key={skill.assistantId} value={skill.assistantId}>{skill.name} · {skill.activeVersion}</option>)}
        </select>
      </label>

      <section className="eval-section">
        <div className="eval-section-heading"><div><h3>冻结用例</h3><p>用户纠正会自动进入这里，也可手动添加必须命中的关键内容。</p></div><span>{cases.filter((item) => item.enabled).length} 条启用</span></div>
        <div className="eval-case-form">
          <textarea rows={2} placeholder="用户输入" value={caseInput} onChange={(event) => setCaseInput(event.currentTarget.value)} />
          <textarea rows={2} placeholder="回复必须包含的内容；每行一项" value={expected} onChange={(event) => setExpected(event.currentTarget.value)} />
          <button disabled={!caseInput.trim() || !expected.trim() || busyId === "new-case"} type="button" onClick={() => void addGoldenCase()}>添加冻结用例</button>
        </div>
        <div className="eval-case-list">
          {cases.map((testCase) => <article className={testCase.enabled ? "" : "disabled"} key={testCase.id}>
            <div><strong>{testCase.input}</strong><small>{sourceLabel(testCase.source)} · {assertionSummary(testCase)}</small></div>
            <button type="button" onClick={() => void setEvalCaseEnabled(testCase.id, !testCase.enabled).then(() => selected && listEvalCases(selected.assistantId, selected.activeVersion).then(setCases))}>{testCase.enabled ? "停用" : "启用"}</button>
            <button className="danger" type="button" onClick={() => void deleteEvalCase(testCase.id).then(() => setCases((current) => current.filter((item) => item.id !== testCase.id)))}>删除</button>
          </article>)}
          {!cases.length ? <p className="eval-empty">还没有冻结用例。没有用例时评测门禁会拒绝发布。</p> : null}
        </div>
      </section>

      <section className="eval-section">
        <div className="eval-section-heading"><div><h3>Prompt 候选</h3><p>完整 Prompt 只在你开始编辑时加载；原版本保持不可变。</p></div><button type="button" onClick={() => void beginPromptCandidate()}>新建候选</button></div>
        {editorOpen ? <div className="eval-candidate-editor">
          <label>候选版本<input value={versionDraft} onChange={(event) => setVersionDraft(event.currentTarget.value)} /></label>
          <label>System Prompt<textarea rows={7} value={promptDraft} onChange={(event) => setPromptDraft(event.currentTarget.value)} /></label>
          <label>变更理由<input placeholder="这次想改善什么" value={rationale} onChange={(event) => setRationale(event.currentTarget.value)} /></label>
          <div><button type="button" onClick={() => setEditorOpen(false)}>取消</button><button className="approve" disabled={busyId === "new-candidate" || !promptDraft.trim()} type="button" onClick={() => void savePromptCandidate()}>保存为候选</button></div>
        </div> : null}
        <div className="eval-candidate-list">
          {visibleCandidates.map((candidate) => {
            const run = candidate.latestEvalRunId ? runs[candidate.latestEvalRunId] : undefined;
            return <article key={candidate.id}>
              <div className="eval-candidate-title"><div><strong>{candidate.kind === "assistant_prompt_patch" ? "Prompt Patch" : "Flow Patch"} · {candidate.proposedVersion}</strong><small>基于 {candidate.baseVersion}{candidate.rationale ? ` · ${candidate.rationale}` : ""}</small></div><span className={`eval-status ${candidate.status}`}>{statusLabel(candidate.status)}</span></div>
              {run ? <div className="eval-score"><span>基线 {percent(run.baselineScore)}</span><span>候选 {percent(run.candidateScore)}</span></div> : null}
              {run?.gates.length ? <ul className="eval-gates">{run.gates.map((item) => <li className={item.passed ? "passed" : "failed"} key={item.id}><span>{item.passed ? "✓" : "×"}</span><div><strong>{item.label}</strong><small>{item.detail}</small></div></li>)}</ul> : null}
              <div className="skill-card-actions">
                {candidate.status !== "published" && candidate.status !== "rejected" ? <button disabled={busyId === candidate.id || candidate.status === "evaluating"} type="button" onClick={() => void perform(candidate, async () => { await runner.run(candidate.id); })}>运行评测</button> : null}
                {candidate.status === "passed" ? <button className="approve" disabled={busyId === candidate.id} type="button" onClick={() => void perform(candidate, async () => { await publishPassedCandidate(candidate.id, runtime); })}>发布并设为当前版本</button> : null}
                {candidate.status !== "published" && candidate.status !== "rejected" ? <button className="danger" disabled={busyId === candidate.id} type="button" onClick={() => void perform(candidate, async () => { await setArtifactCandidateStatus(candidate.id, "rejected"); })}>拒绝</button> : null}
              </div>
            </article>;
          })}
          {!visibleCandidates.length ? <p className="eval-empty">还没有候选变更。</p> : null}
        </div>
      </section>
      <p className="memory-privacy-note">评测记录、输出和版本均保存在本机。评测只允许无副作用能力；发布始终需要人工点击。</p>
    </div>
  );
}

function sourceLabel(source: EvalCase["source"]): string { return source === "user_correction" ? "用户纠正" : source === "regression" ? "回归用例" : "人工基准"; }
function assertionSummary(testCase: EvalCase): string {
  if (testCase.assertions.referenceAnswer) return `参考答案：${testCase.assertions.referenceAnswer.slice(0, 80)}`;
  return `必须包含：${testCase.assertions.mustContain?.join("、") ?? "-"}`;
}
function statusLabel(status: ArtifactCandidate["status"]): string {
  return ({ pending: "待评测", evaluating: "评测中", passed: "已通过", failed: "未通过", published: "已发布", rejected: "已拒绝" })[status];
}
function percent(value?: number): string { return value === undefined ? "-" : `${(value * 100).toFixed(0)}%`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function CloseIcon() { return <svg aria-hidden viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>; }
