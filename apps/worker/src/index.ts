import "./env";
process.env.DATABASE_URL ??= "file:./dev.db";

import { DEFAULT_KEYWORDS, FETCH_FREQUENCIES } from "@koc-dashboard/shared";
import { claimNextJob, prisma, processJob, scheduleDueAutoFetches } from "./jobs";

const bootedAt = new Date();
const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5_000);
let isTicking = false;
let workerTimer: NodeJS.Timeout | null = null;

function logWorkerEvent(event: string, details: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      service: "koc-dashboard-worker",
      event,
      bootedAt: bootedAt.toISOString(),
      checkedAt: new Date().toISOString(),
      supportedFetchFrequencies: FETCH_FREQUENCIES,
      defaultKeywordCount: DEFAULT_KEYWORDS.length,
      ...details
    })
  );
}

async function tick(): Promise<void> {
  if (isTicking) {
    return;
  }

  isTicking = true;

  try {
    const scheduledCount = await scheduleDueAutoFetches();
    const job = await claimNextJob();

    if (!job) {
      if (scheduledCount > 0) {
        logWorkerEvent("scheduled_auto_fetches", {
          scheduledCount
        });
      }
      return;
    }

    logWorkerEvent("job_started", {
      jobId: job.id,
      jobType: job.type
    });

    await processJob(job);

    logWorkerEvent("job_finished", {
      jobId: job.id,
      jobType: job.type
    });
  } catch (error) {
    logWorkerEvent("job_failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    isTicking = false;
  }
}

export function startWorker(): { stop: () => Promise<void> } {
  if (workerTimer) {
    return {
      stop: stopWorker
    };
  }

  logWorkerEvent("started", {
    pollIntervalMs
  });
  void tick();
  workerTimer = setInterval(() => {
    void tick();
  }, pollIntervalMs);

  return {
    stop: stopWorker
  };
}

async function stopWorker(): Promise<void> {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }

  logWorkerEvent("shutdown");
  await prisma.$disconnect();
}

async function shutdown(): Promise<void> {
  await stopWorker();
  process.exit(0);
}

function isMainModule(): boolean {
  return process.argv[1] ? import.meta.url === new URL(process.argv[1], "file:").href : false;
}

if (isMainModule()) {
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  startWorker();
}
