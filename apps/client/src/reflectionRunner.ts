import type { NodeEvent } from "@nkg-ai-bot/runtime-router";
import {
  BUILTIN_REFLECTION_FLOW_ID,
  BUILTIN_REFLECTION_FLOW_VERSION,
} from "./builtinFlows";
import {
  cancelLearningJob,
  claimLearningJob,
  completeLearningJob,
  failLearningJob,
  getLearningJob,
  interruptLearningJob,
  requeueLearningJob,
  updateLearningJobRun,
  type LearningJob,
} from "./learningJobs";
import {
  listMessageFeedback,
  proposeMemoryCandidate,
  type MessageFeedback,
} from "./learningRepository";
import { listMessages, type LocalMessage } from "./storage/repositories";

export interface ReflectionRuntime {
  stream(
    flowId: string,
    input: unknown,
    options?: {
      flowVersion?: string;
      signal?: AbortSignal;
      onRunStarted?: (runId: string) => void;
    },
  ): AsyncIterable<NodeEvent>;
  cancel(runId: string, signal?: AbortSignal): Promise<void>;
}

export interface ReflectionMemoryCandidate {
  content: string;
  confidence: number;
  rationale: string;
}

export interface ReflectionDocument {
  memoryCandidates: ReflectionMemoryCandidate[];
  rejectedCount: number;
}

interface ActiveReflection {
  controller: AbortController;
  cancelled: boolean;
  runId?: string;
}

export interface ReflectionJobStore {
  getJob(id: string): Promise<LearningJob | undefined>;
  claim(id: string): Promise<LearningJob>;
  updateRun(id: string, runId: string): Promise<void>;
  complete(id: string, result: Record<string, unknown>): Promise<void>;
  fail(id: string, error: unknown): Promise<void>;
  interrupt(id: string, error: unknown): Promise<void>;
  cancel(id: string): Promise<void>;
  requeue(id: string): Promise<void>;
  listMessages(conversationId: string): Promise<LocalMessage[]>;
  listFeedback(conversationId: string): Promise<MessageFeedback[]>;
  propose(input: Parameters<typeof proposeMemoryCandidate>[0]): Promise<{ id: string }>;
}

const sqliteReflectionStore: ReflectionJobStore = {
  getJob: (id) => getLearningJob(id),
  claim: (id) => claimLearningJob(id),
  updateRun: (id, runId) => updateLearningJobRun(id, runId),
  complete: (id, result) => completeLearningJob(id, result),
  fail: (id, error) => failLearningJob(id, error),
  interrupt: (id, error) => interruptLearningJob(id, error),
  cancel: (id) => cancelLearningJob(id),
  requeue: (id) => requeueLearningJob(id),
  listMessages: (conversationId) => listMessages(conversationId),
  listFeedback: (conversationId) => listMessageFeedback(conversationId),
  propose: (input) => proposeMemoryCandidate(input),
};

export class ReflectionJobRunner {
  private readonly active = new Map<string, ActiveReflection>();

  constructor(
    private readonly runtime: ReflectionRuntime,
    private readonly store: ReflectionJobStore = sqliteReflectionStore,
  ) {}

  isRunning(jobId: string): boolean {
    return this.active.has(jobId);
  }

  async run(jobId: string): Promise<LearningJob> {
    if (this.active.has(jobId)) throw new Error("Learning job is already running");
    const active: ActiveReflection = { controller: new AbortController(), cancelled: false };
    this.active.set(jobId, active);
    try {
      const job = await this.store.claim(jobId);
      const [messages, feedback] = await Promise.all([
        this.store.listMessages(job.sourceConversationId),
        this.store.listFeedback(job.sourceConversationId),
      ]);
      const prompt = buildReflectionPrompt(messages, feedback, job.sourceMessageId);
      let streamed = "";
      let finalOutput = "";
      let runUpdate: Promise<void> = Promise.resolve();
      for await (const event of this.runtime.stream(BUILTIN_REFLECTION_FLOW_ID, prompt, {
        flowVersion: BUILTIN_REFLECTION_FLOW_VERSION,
        signal: active.controller.signal,
        onRunStarted: (runId) => {
          active.runId = runId;
          runUpdate = this.store.updateRun(jobId, runId);
        },
      })) {
        if (event.kind === "stream_delta" && event.nodeId === "reflection_model") {
          streamed += readTextDelta(event.payload);
        }
        if (event.kind === "run_finished") {
          const output = readRunOutput(event.payload);
          if (output) finalOutput = output;
        }
        if (event.kind === "node_error" || event.kind === "run_failed") {
          throw new Error(readRuntimeError(event.payload));
        }
        if (event.kind === "run_cancelled") {
          throw new DOMException("Reflection Flow was cancelled", "AbortError");
        }
      }
      await runUpdate;
      const document = parseReflectionOutput(finalOutput || streamed);
      const candidateIds: string[] = [];
      for (const candidate of document.memoryCandidates) {
        const saved = await this.store.propose({
          content: candidate.content,
          confidence: candidate.confidence,
          rationale: `Reflection Flow：${candidate.rationale}`,
          sourceMessageId: job.sourceMessageId,
          sourceConversationId: job.sourceConversationId,
          jobId,
        });
        candidateIds.push(saved.id);
      }
      await this.store.complete(jobId, {
        candidateIds,
        proposedCount: candidateIds.length,
        rejectedCount: document.rejectedCount,
        ...(active.runId ? { runtimeRunId: active.runId } : {}),
      });
      return requireJob(await this.store.getJob(jobId));
    } catch (error: unknown) {
      if (active.cancelled) {
        await this.store.cancel(jobId);
      } else if (isAbort(error)) {
        await this.store.interrupt(jobId, error);
      } else {
        await this.store.fail(jobId, error);
      }
      throw error;
    } finally {
      this.active.delete(jobId);
    }
  }

  async retry(jobId: string): Promise<LearningJob> {
    await this.store.requeue(jobId);
    return this.run(jobId);
  }

  async cancel(jobId: string): Promise<void> {
    const active = this.active.get(jobId);
    if (!active) {
      await this.store.cancel(jobId);
      return;
    }
    active.cancelled = true;
    if (active.runId) {
      try {
        await this.runtime.cancel(active.runId);
      } catch {
        // The local job state still records the user's cancellation even if
        // the runtime already reached a terminal state.
      }
    }
    active.controller.abort(new DOMException("Learning job cancelled by user", "AbortError"));
    await this.store.cancel(jobId);
  }
}

export function buildReflectionPrompt(
  messages: LocalMessage[],
  feedback: MessageFeedback[],
  sourceMessageId?: string,
): string {
  const feedbackByMessage = new Map(feedback.map((item) => [item.messageId, item]));
  const evidence: string[] = [];
  let size = 0;
  for (const message of messages
    .filter((item) => item.role === "user" || item.role === "assistant")
    .slice(-24)
    .reverse()) {
    const rating = feedbackByMessage.get(message.id);
    const line = [
      `${message.role === "user" ? "用户" : "助手"}${message.id === sourceMessageId ? "（本次反馈目标）" : ""}：${redactSensitiveText(messageText(message.content))}`,
      rating ? `反馈：${rating.rating === "positive" ? "有帮助" : "需改进"}${rating.correction ? `；用户纠正：${redactSensitiveText(rating.correction)}` : ""}` : "",
    ].filter(Boolean).join("\n");
    if (size + line.length > 10_000) continue;
    evidence.unshift(line);
    size += line.length;
  }
  return [
    "你是本地 AI 客户端的学习反思器。根据下方有限的对话与用户反馈，只提出稳定、可复用、明确属于用户的事实或偏好。",
    "不要记录助手自己的说法、一次性任务、推测、健康/财务等敏感推断，也绝不能记录 API Key、密码、Token、私钥或其他凭据。",
    "如果证据不足，返回空数组。最多返回 5 条。只输出一个 JSON 对象，不要 Markdown，不要解释。",
    '严格格式：{"memoryCandidates":[{"content":"简短事实","confidence":0.0,"rationale":"证据理由"}]}',
    "本地证据：",
    evidence.join("\n\n") || "（无可用证据）",
  ].join("\n\n");
}

export function parseReflectionOutput(output: string): ReflectionDocument {
  if (!output.trim()) throw new Error("Reflection Flow returned an empty response");
  if (output.length > 20_000) throw new Error("Reflection Flow response exceeded the local safety limit");
  const json = extractJsonObject(output);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Reflection Flow did not return valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Reflection Flow response must be a JSON object");
  }
  const candidates = (value as { memoryCandidates?: unknown }).memoryCandidates;
  if (!Array.isArray(candidates)) {
    throw new Error("Reflection Flow response is missing memoryCandidates");
  }
  const accepted: ReflectionMemoryCandidate[] = [];
  let rejectedCount = Math.max(candidates.length - 5, 0);
  for (const raw of candidates.slice(0, 5)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      rejectedCount += 1;
      continue;
    }
    const item = raw as Record<string, unknown>;
    const content = typeof item.content === "string" ? item.content.trim().replace(/\s+/g, " ") : "";
    const confidence = typeof item.confidence === "number" ? item.confidence : Number.NaN;
    const rationale = typeof item.rationale === "string" ? item.rationale.trim() : "";
    if (
      !content
      || content.length > 1_000
      || !Number.isFinite(confidence)
      || confidence < 0
      || confidence > 1
      || containsSensitiveCredential(content)
    ) {
      rejectedCount += 1;
      continue;
    }
    accepted.push({ content, confidence, rationale: rationale.slice(0, 500) || "模型根据用户反馈提出" });
  }
  return { memoryCandidates: accepted, rejectedCount };
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_API_KEY]")
    .replace(/(api[_ -]?key|token|password|密码|密钥)\s*[:=：]\s*\S+/gi, "$1: [REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}

function containsSensitiveCredential(text: string): boolean {
  return /\bsk-[A-Za-z0-9_-]{8,}\b/i.test(text)
    || /(api[_ -]?key|token|password|密码|密钥)\s*[:=：]/i.test(text)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text);
}

function extractJsonObject(output: string): string {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) return fenced;
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Reflection Flow response did not contain a JSON object");
  return output.slice(start, end + 1);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  try { return JSON.stringify(content); } catch { return String(content); }
}

function readTextDelta(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function readRunOutput(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const output = (payload as { output?: unknown }).output;
  return typeof output === "string" ? output : "";
}

function readRuntimeError(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "Reflection Flow failed";
  const error = (payload as { error?: unknown }).error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  const message = (payload as { message?: unknown }).message;
  return typeof message === "string" && message ? message : "Reflection Flow failed";
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function requireJob(job: LearningJob | undefined): LearningJob {
  if (!job) throw new Error("Learning job was not found after completion");
  return job;
}
