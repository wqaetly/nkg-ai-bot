import { createReflectionJob, type LearningJob } from "./learningJobs";

export interface LocalMemoryArchiveRunner {
  run(jobId: string): Promise<LearningJob>;
}

export interface LocalMemoryArchiveTurn {
  conversationId: string;
  assistantMessageId: string;
  memoryNamespace: string;
}

type CreateArchiveJob = typeof createReflectionJob;

/**
 * Serializes automatic reflection calls so consecutive chat turns do not run
 * multiple archival LLM requests at the same time.
 */
export class LocalMemoryTurnArchiver {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly runner: LocalMemoryArchiveRunner,
    private readonly createJob: CreateArchiveJob = createReflectionJob,
  ) {}

  enqueue(turn: LocalMemoryArchiveTurn): Promise<LearningJob> {
    const task = this.queue.then(async () => {
      const job = await this.createJob({
        sourceConversationId: turn.conversationId,
        sourceMessageId: turn.assistantMessageId,
        mode: "auto_archive",
        memoryNamespace: turn.memoryNamespace,
      });
      return this.runner.run(job.id);
    });
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }
}
