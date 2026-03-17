/**
 * Fire-and-forget async queue for memory extraction jobs.
 * enqueue() returns void immediately — never blocks the caller.
 * Bounded to MAX_QUEUE_SIZE; oldest job dropped on overflow.
 * All failures are silently logged — never propagate to caller.
 */

export interface ExtractionJob {
  agentId?: string;
  projectId?: string;
  sessionId?: string;
  /** The text to extract memories from (conversation turn, session chunk, etc.) */
  turn: string;
  timestamp: number;
  /** Metadata passed through to the extraction pipeline */
  source?: "turn" | "session" | "manual";
}

export interface QueueStats {
  pending: number;
  processing: number;
  processed: number;
  failed: number;
  dropped: number; // jobs dropped due to overflow
}

type JobHandler = (job: ExtractionJob) => Promise<void>;

const MAX_QUEUE_SIZE = 100;
const CONCURRENCY = 3; // process up to 3 jobs at once

class AutoMemoryQueue {
  private queue: ExtractionJob[] = [];
  private handler: JobHandler | null = null;
  private running = false;
  private activeCount = 0;

  private stats: QueueStats = {
    pending: 0,
    processing: 0,
    processed: 0,
    failed: 0,
    dropped: 0,
  };

  /** Register the handler that processes each job */
  setHandler(handler: JobHandler): void {
    this.handler = handler;
    if (!this.running) this.startLoop();
  }

  /**
   * Enqueue a job. Returns immediately — never awaits.
   * If queue is full, drops the oldest job (FIFO overflow).
   */
  enqueue(job: ExtractionJob): void {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.queue.shift(); // drop oldest
      this.stats.dropped++;
      this.stats.pending = Math.max(0, this.stats.pending - 1);
    }
    this.queue.push(job);
    this.stats.pending++;
    // Kick the loop if it stalled
    if (!this.running && this.handler) this.startLoop();
  }

  getStats(): Readonly<QueueStats> {
    return { ...this.stats, pending: this.queue.length };
  }

  private startLoop(): void {
    this.running = true;
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (this.queue.length > 0 || this.activeCount > 0) {
      // Fill up to CONCURRENCY
      while (this.queue.length > 0 && this.activeCount < CONCURRENCY) {
        const job = this.queue.shift();
        if (!job) break;
        this.stats.pending = Math.max(0, this.stats.pending - 1);
        this.activeCount++;
        this.stats.processing = this.activeCount;
        void this.processJob(job);
      }
      // Yield to event loop
      await new Promise<void>((r) => setImmediate(r));
    }
    this.running = false;
  }

  private async processJob(job: ExtractionJob): Promise<void> {
    if (!this.handler) {
      this.activeCount--;
      this.stats.processing = this.activeCount;
      return;
    }
    try {
      await this.handler(job);
      this.stats.processed++;
    } catch (err) {
      this.stats.failed++;
      console.error("[auto-memory-queue] job failed:", err);
    } finally {
      this.activeCount--;
      this.stats.processing = this.activeCount;
    }
  }
}

/** Singleton queue — shared across the process */
export const autoMemoryQueue = new AutoMemoryQueue();
