import { describe, expect, it, vi } from "vitest";
import { LocalMemoryTurnArchiver } from "../src/localMemoryArchive";
import type { LearningJob } from "../src/learningJobs";

function job(id: string): LearningJob {
  return {
    id,
    type: "reflection",
    sourceConversationId: "conversation-1",
    sourceMessageId: "assistant-1",
    mode: "auto_archive",
    memoryNamespace: "global",
    status: "queued",
    checkpoint: { phase: "queued", mode: "auto_archive", memoryNamespace: "global" },
    attempt: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("LocalMemoryTurnArchiver", () => {
  it("creates an automatic archive job for every successful turn", async () => {
    const createJob = vi.fn(async (input) => ({
      ...job(`job-${input.sourceMessageId}`),
      sourceConversationId: input.sourceConversationId,
      sourceMessageId: input.sourceMessageId,
      memoryNamespace: input.memoryNamespace ?? "global",
    }));
    const runner = { run: vi.fn(async (id: string) => ({ ...job(id), status: "succeeded" as const })) };
    const archiver = new LocalMemoryTurnArchiver(runner, createJob);

    await Promise.all([
      archiver.enqueue({
        conversationId: "conversation-1",
        assistantMessageId: "assistant-1",
        memoryNamespace: "global",
      }),
      archiver.enqueue({
        conversationId: "conversation-1",
        assistantMessageId: "assistant-2",
        memoryNamespace: "computer_config",
      }),
    ]);

    expect(createJob).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sourceMessageId: "assistant-1",
      mode: "auto_archive",
      memoryNamespace: "global",
    }));
    expect(createJob).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sourceMessageId: "assistant-2",
      mode: "auto_archive",
      memoryNamespace: "computer_config",
    }));
    expect(runner.run.mock.calls.map(([id]) => id)).toEqual([
      "job-assistant-1",
      "job-assistant-2",
    ]);
  });

  it("continues with the next turn after an archive failure", async () => {
    const createJob = vi.fn(async (input) => job(`job-${input.sourceMessageId}`));
    const runner = {
      run: vi.fn()
        .mockRejectedValueOnce(new Error("archive failed"))
        .mockResolvedValueOnce({ ...job("job-assistant-2"), status: "succeeded" as const }),
    };
    const archiver = new LocalMemoryTurnArchiver(runner, createJob);

    await expect(archiver.enqueue({
      conversationId: "conversation-1",
      assistantMessageId: "assistant-1",
      memoryNamespace: "global",
    })).rejects.toThrow("archive failed");
    await expect(archiver.enqueue({
      conversationId: "conversation-1",
      assistantMessageId: "assistant-2",
      memoryNamespace: "global",
    })).resolves.toMatchObject({ status: "succeeded" });
  });
});
