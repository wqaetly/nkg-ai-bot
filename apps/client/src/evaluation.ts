import { validateFlow } from "@ai-native-flow/flow-validator";
import type { AppPlatform, FlowInvokeResult } from "@nkg-ai-bot/runtime-router";
import {
  getAssistantSkillVersion,
  promoteAssistantSkillVersion,
  publishAssistantSkillVersion,
  type AssistantSkillVersion,
} from "./assistantSkills";
import { analyzeFlowCapabilities, type ProductCapability } from "./capabilityPolicy";
import { buildChatPrompt } from "./chatSession";
import {
  finishEvalRun,
  getArtifactCandidate,
  getEvalRun,
  listEvalCases,
  saveEvalCaseResult,
  setArtifactCandidateStatus,
  startEvalRun,
  type ArtifactCandidate,
  type EvalAssertions,
  type EvalCase,
  type EvalGate,
  type EvalRun,
  type FlowPatchProposal,
  type PromptPatchProposal,
} from "./evaluationRepository";
import { getStoredFlow, publishFlowVersion } from "./storage/repositories";

const SAFE_EVALUATION_CAPABILITIES = new Set<ProductCapability>(["network.http", "secret.read"]);
const MINIMUM_CANDIDATE_SCORE = 0.6;
const REGRESSION_TOLERANCE = 0.01;

export interface EvaluationRuntime {
  registerFlow(graph: unknown, signal?: AbortSignal): Promise<void>;
  invoke(
    flowId: string,
    input: unknown,
    options?: { flowVersion?: string; signal?: AbortSignal },
  ): Promise<FlowInvokeResult>;
}

export class CandidateEvaluationRunner {
  constructor(
    private readonly runtime: EvaluationRuntime,
    private readonly platform: AppPlatform,
  ) {}

  async run(candidateId: string, signal?: AbortSignal): Promise<EvalRun> {
    const candidate = await getArtifactCandidate(candidateId);
    if (!candidate) throw new Error("候选变更不存在");
    if (!["pending", "failed", "passed"].includes(candidate.status)) {
      throw new Error("当前候选状态不能启动评测");
    }
    const run = await startEvalRun(candidate.id);
    let gates: EvalGate[] = [];
    try {
      const base = await getAssistantSkillVersion(candidate.assistantId, candidate.baseVersion);
      if (!base) throw new Error("候选所基于的 Assistant 版本不存在");
      const baseFlow = await getStoredFlow(base.flowId, base.flowVersion);
      if (!baseFlow) throw new Error("基础 Flow 版本不存在");
      const cases = (await listEvalCases(base.assistantId, base.version)).filter((item) => item.enabled);
      const prepared = prepareEvaluation(candidate, base, baseFlow.graph, cases, this.platform);
      gates = prepared.gates;
      if (gates.some((gate) => !gate.passed)) {
        await finishEvalRun(run.id, { status: "failed", gates, summary: { caseCount: cases.length } });
        await setArtifactCandidateStatus(candidate.id, "failed", { evalRunId: run.id });
        return (await getEvalRun(run.id))!;
      }

      throwIfAborted(signal);
      await this.runtime.registerFlow(prepared.baselineGraph, signal);
      if (prepared.candidateGraph !== prepared.baselineGraph) {
        await this.runtime.registerFlow(prepared.candidateGraph, signal);
      }

      const baselineScores: number[] = [];
      const candidateScores: number[] = [];
      const caseRegressions: string[] = [];
      for (const testCase of cases) {
        throwIfAborted(signal);
        const baseline = await executeCase(this.runtime, prepared.baselineGraph, base.systemPrompt, testCase, signal);
        await saveEvalCaseResult({ evalRunId: run.id, caseId: testCase.id, variant: "baseline", ...baseline });
        const proposedPrompt = candidate.kind === "assistant_prompt_patch"
          ? (candidate.proposal as PromptPatchProposal).systemPrompt
          : base.systemPrompt;
        const proposed = await executeCase(this.runtime, prepared.candidateGraph, proposedPrompt, testCase, signal);
        await saveEvalCaseResult({ evalRunId: run.id, caseId: testCase.id, variant: "candidate", ...proposed });
        baselineScores.push(baseline.score);
        candidateScores.push(proposed.score);
        if (proposed.score + REGRESSION_TOLERANCE < baseline.score) caseRegressions.push(testCase.id);
      }

      const baselineScore = mean(baselineScores);
      const candidateScore = mean(candidateScores);
      gates = [
        ...gates,
        gate("score_floor", "质量下限", candidateScore >= MINIMUM_CANDIDATE_SCORE,
          `候选 ${(candidateScore * 100).toFixed(0)}%，要求至少 ${MINIMUM_CANDIDATE_SCORE * 100}%`),
        gate("aggregate_regression", "总体不退化", candidateScore + REGRESSION_TOLERANCE >= baselineScore,
          `基线 ${(baselineScore * 100).toFixed(0)}%，候选 ${(candidateScore * 100).toFixed(0)}%`),
        gate("case_regression", "单例不退化", caseRegressions.length === 0,
          caseRegressions.length ? `${caseRegressions.length} 条冻结用例退化` : "没有冻结用例退化"),
      ];
      const passed = gates.every((item) => item.passed);
      await finishEvalRun(run.id, {
        status: passed ? "passed" : "failed",
        baselineScore,
        candidateScore,
        gates,
        summary: { caseCount: cases.length, regressedCaseIds: caseRegressions },
      });
      await setArtifactCandidateStatus(candidate.id, passed ? "passed" : "failed", { evalRunId: run.id });
      return (await getEvalRun(run.id))!;
    } catch (error: unknown) {
      const cancelled = isAbort(error);
      await finishEvalRun(run.id, {
        status: cancelled ? "cancelled" : "failed",
        gates,
        error,
      });
      await setArtifactCandidateStatus(candidate.id, "pending", { evalRunId: run.id });
      throw error;
    }
  }
}

export async function publishPassedCandidate(
  candidateId: string,
  runtime: Pick<EvaluationRuntime, "registerFlow">,
): Promise<AssistantSkillVersion> {
  const candidate = await getArtifactCandidate(candidateId);
  if (!candidate || candidate.status !== "passed") throw new Error("只有通过评测的候选才能发布");
  const run = candidate.latestEvalRunId ? await getEvalRun(candidate.latestEvalRunId) : undefined;
  if (!run || run.status !== "passed" || run.gates.some((item) => !item.passed)) {
    throw new Error("候选缺少完整通过的评测门禁");
  }
  const base = await getAssistantSkillVersion(candidate.assistantId, candidate.baseVersion);
  if (!base) throw new Error("基础 Assistant 版本不存在");

  let systemPrompt = base.systemPrompt;
  let flowId = base.flowId;
  let flowVersion = base.flowVersion;
  let capabilities = base.capabilities;
  if (candidate.kind === "assistant_prompt_patch") {
    systemPrompt = (candidate.proposal as PromptPatchProposal).systemPrompt.trim();
  } else {
    const proposal = candidate.proposal as FlowPatchProposal;
    const parsed = validateFlow(proposal.graph);
    if (!parsed.result.ok || !parsed.flow) throw new Error(formatValidationErrors(parsed.result.errors));
    flowId = parsed.flow.id;
    flowVersion = parsed.flow.version;
    const report = analyzeFlowCapabilities(parsed.flow, "windows");
    capabilities = report.required;
    await runtime.registerFlow(parsed.flow);
    await publishFlowVersion({ id: flowId, version: flowVersion, name: proposal.name, graph: parsed.flow });
  }
  const published = await publishAssistantSkillVersion({
    ...base,
    version: candidate.proposedVersion,
    systemPrompt,
    flowId,
    flowVersion,
    capabilities,
  });
  await promoteAssistantSkillVersion(published.assistantId, published.version);
  await setArtifactCandidateStatus(candidate.id, "published");
  return published;
}

export function nextPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error("基础版本不是有效的语义化版本");
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function prepareEvaluation(
  candidate: ArtifactCandidate,
  base: AssistantSkillVersion,
  baseGraph: unknown,
  cases: EvalCase[],
  platform: AppPlatform,
): { gates: EvalGate[]; baselineGraph: unknown; candidateGraph: unknown } {
  const baseValidation = validateFlow(baseGraph);
  const candidateSource = candidate.kind === "flow_patch"
    ? (candidate.proposal as FlowPatchProposal).graph
    : baseGraph;
  const candidateValidation = validateFlow(candidateSource);
  const baseReport = analyzeFlowCapabilities(baseGraph, platform);
  const candidateReport = analyzeFlowCapabilities(candidateSource, platform);
  const baseCapabilities = new Set(baseReport.required);
  const expansion = candidateReport.required.filter((item) => !baseCapabilities.has(item));
  const unsafe = candidateReport.required.filter((item) => !SAFE_EVALUATION_CAPABILITIES.has(item));
  const sensitive = candidate.kind === "assistant_prompt_patch"
    ? containsCredential((candidate.proposal as PromptPatchProposal).systemPrompt)
    : containsCredential(JSON.stringify(candidateSource));
  const gates = [
    gate("frozen_cases", "冻结用例", cases.length > 0, cases.length ? `${cases.length} 条已启用用例` : "至少需要 1 条已启用用例"),
    gate("base_schema", "基础 Flow 结构", baseValidation.result.ok,
      baseValidation.result.ok ? "结构有效" : formatValidationErrors(baseValidation.result.errors)),
    gate("candidate_schema", "候选 Flow 结构", candidateValidation.result.ok,
      candidateValidation.result.ok ? "结构有效" : formatValidationErrors(candidateValidation.result.errors)),
    gate("capability_expansion", "能力不扩张", expansion.length === 0,
      expansion.length ? `新增能力：${expansion.join("、")}` : "候选未新增系统能力"),
    gate("safe_replay", "无副作用回放", unsafe.length === 0,
      unsafe.length ? `评测禁止执行：${unsafe.join("、")}` : "仅使用网络与运行密钥能力"),
    gate("platform", "当前平台可执行", candidateReport.unavailable.length === 0,
      candidateReport.unavailable.length ? `平台缺少：${candidateReport.unavailable.join("、")}` : "当前平台能力满足"),
    gate("sensitive_data", "敏感信息扫描", !sensitive,
      sensitive ? "候选包含疑似密钥或 Authorization 内容" : "未发现明文凭据"),
    gate("version", "新版本号", candidate.proposedVersion !== base.version,
      candidate.proposedVersion === base.version ? "候选版本不能覆盖基础版本" : `${base.version} → ${candidate.proposedVersion}`),
  ];
  if (!baseValidation.flow || !candidateValidation.flow) {
    return { gates, baselineGraph: baseGraph, candidateGraph: candidateSource };
  }
  // Stable internal versions keep the runtime registry bounded across retries.
  const baselineSuffix = semanticIdentifier(`${base.assistantId}-${base.version}`);
  const candidateSuffix = semanticIdentifier(candidate.id);
  const baselineGraph = makeDeterministicGraph(baseValidation.flow, `0.0.0-eval.base.${baselineSuffix}`);
  return {
    gates,
    baselineGraph,
    candidateGraph: candidate.kind === "flow_patch"
      ? makeDeterministicGraph(candidateValidation.flow, `0.0.0-eval.candidate.${candidateSuffix}`)
      : baselineGraph,
  };
}

async function executeCase(
  runtime: EvaluationRuntime,
  graph: unknown,
  systemPrompt: string,
  testCase: EvalCase,
  signal?: AbortSignal,
): Promise<Omit<Parameters<typeof saveEvalCaseResult>[0], "evalRunId" | "caseId" | "variant">> {
  const identity = graph as { id: string; version: string };
  try {
    const prompt = buildChatPrompt([{
      id: `eval-${testCase.id}`,
      conversationId: `eval-${testCase.id}`,
      sequence: 0,
      role: "user",
      content: testCase.input,
      createdAt: testCase.createdAt,
    }], [], systemPrompt);
    const result = await runtime.invoke(identity.id, prompt, { flowVersion: identity.version, signal });
    const outputText = readOutput(result.output);
    const scored = scoreOutput(outputText, testCase.assertions);
    return {
      status: result.status === "succeeded" ? "succeeded" : "failed",
      outputText,
      score: result.status === "succeeded" ? scored.score : 0,
      assertions: scored.assertions,
      runtimeRunId: result.runId,
    };
  } catch (error: unknown) {
    if (isAbort(error)) throw error;
    return {
      status: "failed", outputText: "", score: 0,
      assertions: [{ label: "运行", passed: false, detail: errorMessage(error) }],
    };
  }
}

export function scoreOutput(output: string, assertions: EvalAssertions): {
  score: number;
  assertions: Array<{ label: string; passed: boolean; detail: string }>;
} {
  const checks: Array<{ label: string; passed: boolean; detail: string; score: number }> = [];
  for (const text of assertions.mustContain ?? []) {
    const passed = normalize(output).includes(normalize(text));
    checks.push({ label: `包含「${text}」`, passed, detail: passed ? "已包含" : "未包含", score: passed ? 1 : 0 });
  }
  for (const text of assertions.mustNotContain ?? []) {
    const passed = !normalize(output).includes(normalize(text));
    checks.push({ label: `不包含「${text}」`, passed, detail: passed ? "未出现" : "出现禁用内容", score: passed ? 1 : 0 });
  }
  if (assertions.maxLength !== undefined) {
    const passed = output.length <= assertions.maxLength;
    checks.push({ label: "最大长度", passed, detail: `${output.length}/${assertions.maxLength} 字符`, score: passed ? 1 : 0 });
  }
  if (assertions.referenceAnswer?.trim()) {
    const similarity = lexicalSimilarity(output, assertions.referenceAnswer);
    checks.push({ label: "参考答案相似度", passed: similarity >= MINIMUM_CANDIDATE_SCORE,
      detail: `${(similarity * 100).toFixed(0)}%`, score: similarity });
  }
  return {
    score: mean(checks.map((item) => item.score)),
    assertions: checks.map(({ score: _score, ...item }) => item),
  };
}

function makeDeterministicGraph(flow: unknown, version: string): unknown {
  const clone = structuredClone(flow) as {
    version: string;
    nodes: Array<{ type: string; config: Record<string, unknown> }>;
  };
  clone.version = version;
  for (const node of clone.nodes) {
    if (node.type === "llm" || node.type === "agent") node.config.temperature = 0;
  }
  return clone;
}

function lexicalSimilarity(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const precision = intersection / a.size;
  const recall = intersection / b.size;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

function tokenSet(value: string): Set<string> {
  const normalized = normalize(value);
  const words = normalized.match(/[a-z0-9]+|[\u3400-\u9fff]/g) ?? [];
  return new Set(words);
}

function normalize(value: string): string { return value.toLowerCase().replace(/\s+/g, ""); }
function semanticIdentifier(value: string): string {
  return value.replace(/[^0-9A-Za-z-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "local";
}
function containsCredential(value: string): boolean {
  return /\bsk-[A-Za-z0-9_-]{16,}\b|authorization\s*[:=]\s*bearer\s+\S+|api[_-]?key\s*[:=]\s*["']?\S{12,}/i.test(value);
}
function mean(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function gate(id: string, label: string, passed: boolean, detail: string): EvalGate { return { id, label, passed, detail }; }
function readOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    for (const key of ["answer", "result", "text", "output"]) {
      const value = (output as Record<string, unknown>)[key];
      if (typeof value === "string") return value;
    }
  }
  return output === undefined || output === null ? "" : JSON.stringify(output);
}
function formatValidationErrors(errors: Array<{ message: string }>): string {
  return errors.slice(0, 3).map((item) => item.message).join("；") || "Flow 无效";
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("评测已取消", "AbortError");
}
function isAbort(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
