import { describe, expect, it, vi } from "vitest";
import type { NodeEvent } from "@nkg-ai-bot/runtime-router";
import {
  ReflectionJobRunner,
  buildReflectionPrompt,
  parseReflectionOutput,
  type ReflectionJobStore,
  type ReflectionRuntime,
} from "../src/reflectionRunner";
import type { LearningJob } from "../src/learningJobs";
import type { LocalMessage } from "../src/storage/repositories";

function job(status: LearningJob["status"] = "queued"): LearningJob {
  return {
    id: "job-1",
    type: "reflection",
    sourceConversationId: "conversation-1",
    sourceMessageId: "assistant-1",
    status,
    checkpoint: { phase: status },
    attempt: status === "queued" ? 0 : 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function message(id: string, role: "user" | "assistant", content: string): LocalMessage {
  return { id, conversationId: "conversation-1", sequence: 0, role, content, createdAt: 1 };
}

function event(kind: string, payload: unknown, nodeId?: string): NodeEvent {
  return {
    eventId: crypto.randomUUID(),
    runId: "runtime-run-1",
    flowId: "builtin_reflection",
    flowVersion: "1.0.0",
    seq: 1,
    timestamp: new Date(0).toISOString(),
    kind,
    payload,
    ...(nodeId ? { nodeId } : {}),
  };
}

function store(): ReflectionJobStore & { current: LearningJob } {
  const value = {
    current: job(),
    getJob: vi.fn(async () => value.current),
    claim: vi.fn(async () => {
      value.current = { ...value.current, status: "running", attempt: value.current.attempt + 1 };
      return value.current;
    }),
    updateRun: vi.fn(async () => undefined),
    complete: vi.fn(async (_id: string, result: Record<string, unknown>) => {
      value.current = { ...value.current, status: "succeeded", result };
    }),
    fail: vi.fn(async (_id: string, error: unknown) => {
      value.current = { ...value.current, status: "failed", error: { message: String(error) } };
    }),
    interrupt: vi.fn(async () => {
      value.current = { ...value.current, status: "interrupted" };
    }),
    cancel: vi.fn(async () => {
      value.current = { ...value.current, status: "cancelled" };
    }),
    requeue: vi.fn(async () => {
      value.current = { ...value.current, status: "queued" };
    }),
    listMessages: vi.fn(async () => [
      message("user-1", "user", "我喜欢蓝色"),
      message("assistant-1", "assistant", "你喜欢红色"),
    ]),
    listFeedback: vi.fn(async () => [{
      id: "feedback-1",
      messageId: "assistant-1",
      conversationId: "conversation-1",
      rating: "negative" as const,
      correction: "我喜欢蓝色",
      createdAt: 1,
      updatedAt: 1,
    }]),
    propose: vi.fn(async () => ({ id: "candidate-1" })),
  };
  return value;
}

describe("ReflectionJobRunner", () => {
  it("runs the built-in Flow and stores only reviewable candidates", async () => {
    const data = store();
    const runtime: ReflectionRuntime = {
      stream: vi.fn(async function* (_flowId, _input, options) {
        options?.onRunStarted?.("runtime-run-1");
        yield event("stream_delta", { text: "partial" }, "reflection_model");
        yield event("run_finished", {
          output: JSON.stringify({
            memoryCandidates: [{ content: "用户喜欢蓝色", confidence: 0.98, rationale: "用户明确纠正" }],
          }),
        });
      }),
      cancel: vi.fn(async () => undefined),
    };

    const completed = await new ReflectionJobRunner(runtime, data).run("job-1");

    expect(runtime.stream).toHaveBeenCalledWith(
      "builtin_reflection",
      expect.stringContaining("用户纠正：我喜欢蓝色"),
      expect.objectContaining({ flowVersion: "1.0.0" }),
    );
    expect(data.updateRun).toHaveBeenCalledWith("job-1", "runtime-run-1");
    expect(data.propose).toHaveBeenCalledWith(expect.objectContaining({
      content: "用户喜欢蓝色",
      jobId: "job-1",
      sourceMessageId: "assistant-1",
    }));
    expect(completed.status).toBe("succeeded");
    expect(completed.result).toMatchObject({ proposedCount: 1, candidateIds: ["candidate-1"] });
  });

  it("persists invalid model output as a failed job without creating candidates", async () => {
    const data = store();
    const runtime: ReflectionRuntime = {
      async *stream() { yield event("run_finished", { output: "not-json" }); },
      cancel: vi.fn(async () => undefined),
    };

    await expect(new ReflectionJobRunner(runtime, data).run("job-1"))
      .rejects.toThrow("did not contain a JSON object");
    expect(data.fail).toHaveBeenCalledOnce();
    expect(data.propose).not.toHaveBeenCalled();
    expect(data.current.status).toBe("failed");
  });

  it("marks lifecycle-style aborts as resumable interruptions", async () => {
    const data = store();
    const runtime: ReflectionRuntime = {
      async *stream() { yield event("run_cancelled", {}); },
      cancel: vi.fn(async () => undefined),
    };

    await expect(new ReflectionJobRunner(runtime, data).run("job-1"))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(data.interrupt).toHaveBeenCalledOnce();
    expect(data.current.status).toBe("interrupted");
  });

  it("cancels both the persisted job and its observed runtime run", async () => {
    const data = store();
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const runtime: ReflectionRuntime = {
      stream: vi.fn(async function* (_flowId, _input, options) {
        options?.onRunStarted?.("runtime-run-1");
        notifyStarted?.();
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        });
        yield event("run_finished", { output: "{}" });
      }),
      cancel: vi.fn(async () => undefined),
    };
    const runner = new ReflectionJobRunner(runtime, data);

    const pending = runner.run("job-1");
    await started;
    await runner.cancel("job-1");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.cancel).toHaveBeenCalledWith("runtime-run-1");
    expect(data.cancel).toHaveBeenCalled();
    expect(data.current.status).toBe("cancelled");
  });
});

describe("reflection safety boundary", () => {
  it("parses fenced JSON, caps candidates, and rejects credential-like facts", () => {
    const output = `\`\`\`json\n${JSON.stringify({
      memoryCandidates: [
        { content: "用户喜欢蓝色", confidence: 0.9, rationale: "明确表达" },
        { content: "API Key: sk-abcdefghijk", confidence: 1, rationale: "不应保存" },
        { content: "用户使用 TypeScript", confidence: 0.8, rationale: "明确表达" },
        { content: "第三条", confidence: 0.7, rationale: "证据" },
        { content: "第四条", confidence: 0.7, rationale: "证据" },
        { content: "超过上限", confidence: 0.7, rationale: "证据" },
      ],
    })}\n\`\`\``;

    const parsed = parseReflectionOutput(output);

    expect(parsed.memoryCandidates.map((item) => item.content)).not.toContain(expect.stringContaining("sk-"));
    expect(parsed.memoryCandidates).toHaveLength(4);
    expect(parsed.rejectedCount).toBe(2);
  });

  it("redacts credentials and bounds evidence before calling the model", () => {
    const prompt = buildReflectionPrompt([
      message("old", "user", `很早的内容 ${"x".repeat(11_000)}`),
      message("secret", "user", "API Key: sk-abcdefghijk"),
      message("assistant-1", "assistant", "最近回复"),
    ], [], "assistant-1");

    expect(prompt).not.toContain("sk-abcdefghijk");
    expect(prompt).toContain("[REDACTED]");
    expect(prompt).toContain("最近回复");
    expect(prompt).not.toContain("很早的内容");
  });
});
