import { getDatabase, type DatabaseClient } from "./storage/database";

export type EvalCaseSource = "golden" | "user_correction" | "regression";
export type ArtifactCandidateKind = "assistant_prompt_patch" | "flow_patch";
export type ArtifactCandidateStatus = "pending" | "evaluating" | "passed" | "failed" | "published" | "rejected";
export type EvalRunStatus = "running" | "passed" | "failed" | "cancelled" | "interrupted";

export interface EvalAssertions {
  mustContain?: string[];
  mustNotContain?: string[];
  referenceAnswer?: string;
  maxLength?: number;
}

export interface EvalCase {
  id: string;
  assistantId: string;
  assistantVersion: string;
  input: string;
  assertions: EvalAssertions;
  source: EvalCaseSource;
  sourceMessageId?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PromptPatchProposal { systemPrompt: string }
export interface FlowPatchProposal { graph: unknown; name: string }

export interface ArtifactCandidate {
  id: string;
  kind: ArtifactCandidateKind;
  assistantId: string;
  baseVersion: string;
  proposedVersion: string;
  proposal: PromptPatchProposal | FlowPatchProposal;
  rationale: string;
  status: ArtifactCandidateStatus;
  latestEvalRunId?: string;
  createdAt: number;
  updatedAt: number;
  reviewedAt?: number;
  publishedAt?: number;
}

export interface EvalGate {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface EvalRun {
  id: string;
  candidateId: string;
  status: EvalRunStatus;
  baselineScore?: number;
  candidateScore?: number;
  gates: EvalGate[];
  summary: Record<string, unknown>;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface EvalCaseResultInput {
  evalRunId: string;
  caseId: string;
  variant: "baseline" | "candidate";
  status: "succeeded" | "failed" | "cancelled";
  outputText: string;
  score: number;
  assertions: Array<{ label: string; passed: boolean; detail: string }>;
  runtimeRunId?: string;
}

type EvalCaseRow = {
  id: string; assistant_id: string; assistant_version: string; input_json: string;
  assertions_json: string; source: EvalCaseSource; source_message_id: string | null;
  enabled: number; created_at: number; updated_at: number;
};
type CandidateRow = {
  id: string; kind: ArtifactCandidateKind; assistant_id: string; base_version: string;
  proposed_version: string; proposal_json: string; rationale: string;
  status: ArtifactCandidateStatus; latest_eval_run_id: string | null;
  created_at: number; updated_at: number; reviewed_at: number | null; published_at: number | null;
};
type EvalRunRow = {
  id: string; candidate_id: string; status: EvalRunStatus; baseline_score: number | null;
  candidate_score: number | null; gates_json: string; summary_json: string;
  error_json: string | null; created_at: number; updated_at: number; completed_at: number | null;
};

export async function createEvalCase(
  input: Omit<EvalCase, "id" | "enabled" | "createdAt" | "updatedAt"> & { id?: string },
  client?: DatabaseClient,
): Promise<EvalCase> {
  const question = input.input.trim();
  if (!question) throw new Error("评测输入不能为空");
  validateAssertions(input.assertions);
  const database = client ?? await getDatabase();
  const id = input.id ?? crypto.randomUUID();
  const now = Date.now();
  await database.execute(
    `INSERT INTO eval_cases
       (id, assistant_id, assistant_version, input_json, assertions_json, source,
        source_message_id, enabled, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8)`,
    [id, input.assistantId, input.assistantVersion, JSON.stringify(question),
      JSON.stringify(input.assertions), input.source, input.sourceMessageId ?? null, now],
  );
  const saved = await getEvalCase(id, database);
  if (!saved) throw new Error("评测用例未保存");
  return saved;
}

export async function createEvalCaseFromCorrection(input: {
  assistantId: string;
  assistantVersion: string;
  question: string;
  correction: string;
  sourceMessageId: string;
}, client?: DatabaseClient): Promise<EvalCase> {
  return createEvalCase({
    assistantId: input.assistantId,
    assistantVersion: input.assistantVersion,
    input: input.question,
    assertions: { referenceAnswer: input.correction.trim() },
    source: "user_correction",
    sourceMessageId: input.sourceMessageId,
  }, client);
}

export async function listEvalCases(
  assistantId?: string,
  assistantVersion?: string,
  client?: DatabaseClient,
): Promise<EvalCase[]> {
  const database = client ?? await getDatabase();
  const rows = await database.select<EvalCaseRow[]>(
    `SELECT * FROM eval_cases
      WHERE ($1 IS NULL OR assistant_id=$1) AND ($2 IS NULL OR assistant_version=$2)
      ORDER BY created_at DESC`,
    [assistantId ?? null, assistantVersion ?? null],
  );
  return rows.map(mapEvalCase);
}

export async function setEvalCaseEnabled(id: string, enabled: boolean, client?: DatabaseClient): Promise<void> {
  const database = client ?? await getDatabase();
  await database.execute("UPDATE eval_cases SET enabled=$2, updated_at=$3 WHERE id=$1", [id, enabled ? 1 : 0, Date.now()]);
}

export async function deleteEvalCase(id: string, client?: DatabaseClient): Promise<void> {
  const database = client ?? await getDatabase();
  await database.execute("DELETE FROM eval_cases WHERE id=$1", [id]);
}

export async function createArtifactCandidate(input: {
  kind: ArtifactCandidateKind;
  assistantId: string;
  baseVersion: string;
  proposedVersion: string;
  proposal: PromptPatchProposal | FlowPatchProposal;
  rationale?: string;
}, client?: DatabaseClient): Promise<ArtifactCandidate> {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(input.proposedVersion)) {
    throw new Error("候选版本必须使用语义化版本");
  }
  validateProposal(input.kind, input.proposal);
  const database = client ?? await getDatabase();
  const id = crypto.randomUUID();
  const now = Date.now();
  await database.execute(
    `INSERT INTO artifact_candidates
       (id, kind, assistant_id, base_version, proposed_version, proposal_json,
        rationale, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $8)`,
    [id, input.kind, input.assistantId, input.baseVersion, input.proposedVersion,
      JSON.stringify(input.proposal), input.rationale?.trim() ?? "", now],
  );
  const saved = await getArtifactCandidate(id, database);
  if (!saved) throw new Error("候选变更未保存");
  return saved;
}

export async function getArtifactCandidate(id: string, client?: DatabaseClient): Promise<ArtifactCandidate | undefined> {
  const database = client ?? await getDatabase();
  const [row] = await database.select<CandidateRow[]>("SELECT * FROM artifact_candidates WHERE id=$1", [id]);
  return row ? mapCandidate(row) : undefined;
}

export async function listArtifactCandidates(client?: DatabaseClient): Promise<ArtifactCandidate[]> {
  const database = client ?? await getDatabase();
  const rows = await database.select<CandidateRow[]>("SELECT * FROM artifact_candidates ORDER BY created_at DESC");
  return rows.map(mapCandidate);
}

export async function setArtifactCandidateStatus(
  id: string,
  status: ArtifactCandidateStatus,
  options: { evalRunId?: string } = {},
  client?: DatabaseClient,
): Promise<void> {
  const database = client ?? await getDatabase();
  const now = Date.now();
  await database.execute(
    `UPDATE artifact_candidates SET status=$2,
       latest_eval_run_id=COALESCE($3, latest_eval_run_id), updated_at=$4,
       reviewed_at=CASE WHEN $2 IN ('passed','failed','rejected') THEN $4 ELSE reviewed_at END,
       published_at=CASE WHEN $2='published' THEN $4 ELSE published_at END
     WHERE id=$1`,
    [id, status, options.evalRunId ?? null, now],
  );
}

export async function startEvalRun(candidateId: string, client?: DatabaseClient): Promise<EvalRun> {
  const database = client ?? await getDatabase();
  const id = crypto.randomUUID();
  const now = Date.now();
  await database.execute(
    `INSERT INTO eval_runs (id, candidate_id, status, created_at, updated_at)
     VALUES ($1, $2, 'running', $3, $3)`,
    [id, candidateId, now],
  );
  await setArtifactCandidateStatus(candidateId, "evaluating", { evalRunId: id }, database);
  const run = await getEvalRun(id, database);
  if (!run) throw new Error("评测任务未创建");
  return run;
}

export async function getEvalRun(id: string, client?: DatabaseClient): Promise<EvalRun | undefined> {
  const database = client ?? await getDatabase();
  const [row] = await database.select<EvalRunRow[]>("SELECT * FROM eval_runs WHERE id=$1", [id]);
  return row ? mapEvalRun(row) : undefined;
}

export async function listEvalRuns(client?: DatabaseClient): Promise<EvalRun[]> {
  const database = client ?? await getDatabase();
  const rows = await database.select<EvalRunRow[]>("SELECT * FROM eval_runs ORDER BY created_at DESC");
  return rows.map(mapEvalRun);
}

export async function saveEvalCaseResult(input: EvalCaseResultInput, client?: DatabaseClient): Promise<void> {
  const database = client ?? await getDatabase();
  await database.execute(
    `INSERT INTO eval_case_results
       (eval_run_id, case_id, variant, status, output_text, score, assertions_json,
        runtime_run_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [input.evalRunId, input.caseId, input.variant, input.status, input.outputText,
      clampScore(input.score), JSON.stringify(input.assertions), input.runtimeRunId ?? null, Date.now()],
  );
}

export async function finishEvalRun(id: string, input: {
  status: Exclude<EvalRunStatus, "running">;
  baselineScore?: number;
  candidateScore?: number;
  gates: EvalGate[];
  summary?: Record<string, unknown>;
  error?: unknown;
}, client?: DatabaseClient): Promise<void> {
  const database = client ?? await getDatabase();
  const now = Date.now();
  await database.execute(
    `UPDATE eval_runs SET status=$2, baseline_score=$3, candidate_score=$4,
       gates_json=$5, summary_json=$6, error_json=$7, updated_at=$8, completed_at=$8
     WHERE id=$1 AND status='running'`,
    [id, input.status, input.baselineScore ?? null, input.candidateScore ?? null,
      JSON.stringify(input.gates), JSON.stringify(input.summary ?? {}),
      input.error === undefined ? null : JSON.stringify({ message: errorMessage(input.error) }), now],
  );
}

export async function recoverInterruptedEvalRuns(client?: DatabaseClient): Promise<number> {
  const database = client ?? await getDatabase();
  const now = Date.now();
  const result = await database.execute(
    `UPDATE eval_runs SET status='interrupted', error_json=$1, updated_at=$2, completed_at=$2
     WHERE status='running'`,
    [JSON.stringify({ message: "应用退出时评测尚未结束" }), now],
  );
  await database.execute("UPDATE artifact_candidates SET status='pending', updated_at=$1 WHERE status='evaluating'", [now]);
  return result.rowsAffected;
}

function getEvalCase(id: string, client: DatabaseClient): Promise<EvalCase | undefined> {
  return client.select<EvalCaseRow[]>("SELECT * FROM eval_cases WHERE id=$1", [id])
    .then(([row]) => row ? mapEvalCase(row) : undefined);
}

function mapEvalCase(row: EvalCaseRow): EvalCase {
  return {
    id: row.id, assistantId: row.assistant_id, assistantVersion: row.assistant_version,
    input: String(JSON.parse(row.input_json)), assertions: JSON.parse(row.assertions_json) as EvalAssertions,
    source: row.source, ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
    enabled: row.enabled === 1, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapCandidate(row: CandidateRow): ArtifactCandidate {
  return {
    id: row.id, kind: row.kind, assistantId: row.assistant_id, baseVersion: row.base_version,
    proposedVersion: row.proposed_version,
    proposal: JSON.parse(row.proposal_json) as PromptPatchProposal | FlowPatchProposal,
    rationale: row.rationale, status: row.status,
    ...(row.latest_eval_run_id ? { latestEvalRunId: row.latest_eval_run_id } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.reviewed_at === null ? {} : { reviewedAt: row.reviewed_at }),
    ...(row.published_at === null ? {} : { publishedAt: row.published_at }),
  };
}

function mapEvalRun(row: EvalRunRow): EvalRun {
  const error = row.error_json ? (JSON.parse(row.error_json) as { message?: unknown }).message : undefined;
  return {
    id: row.id, candidateId: row.candidate_id, status: row.status,
    ...(row.baseline_score === null ? {} : { baselineScore: row.baseline_score }),
    ...(row.candidate_score === null ? {} : { candidateScore: row.candidate_score }),
    gates: JSON.parse(row.gates_json) as EvalGate[],
    summary: JSON.parse(row.summary_json) as Record<string, unknown>,
    ...(typeof error === "string" ? { error } : {}), createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function validateAssertions(assertions: EvalAssertions): void {
  const strings = [...(assertions.mustContain ?? []), ...(assertions.mustNotContain ?? [])];
  if (strings.some((value) => !value.trim())) throw new Error("评测断言不能包含空文本");
  if (!strings.length && !assertions.referenceAnswer?.trim() && assertions.maxLength === undefined) {
    throw new Error("至少需要一条评测断言");
  }
  if (assertions.maxLength !== undefined && (!Number.isInteger(assertions.maxLength) || assertions.maxLength < 1)) {
    throw new Error("最大长度必须是正整数");
  }
}

function validateProposal(kind: ArtifactCandidateKind, proposal: PromptPatchProposal | FlowPatchProposal): void {
  if (kind === "assistant_prompt_patch") {
    const prompt = (proposal as PromptPatchProposal).systemPrompt?.trim();
    if (!prompt) throw new Error("System Prompt 不能为空");
    if (prompt.length > 20_000) throw new Error("System Prompt 过长");
    return;
  }
  const flow = proposal as FlowPatchProposal;
  if (!flow.name?.trim() || !flow.graph || typeof flow.graph !== "object") throw new Error("Flow 候选不完整");
}

function clampScore(score: number): number { return Math.max(0, Math.min(1, score)); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
