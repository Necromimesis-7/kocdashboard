import "./env";
import { mkdirSync } from "node:fs";
import path from "node:path";

process.env.NODE_ENV ??= "production";
process.env.API_HOST ??= "0.0.0.0";

configureDataRoot();

const [{ prisma: apiPrisma }, { server, startApiServer }, { startWorker }] = await Promise.all([
  import("./database"),
  import("./server"),
  import("../../worker/src/index.ts")
]);
const worker = startWorker();

async function shutdown(): Promise<void> {
  await worker.stop();
  await apiPrisma.$disconnect();
  await server.close();
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

try {
  await startApiServer();
} catch (error) {
  server.log.error(error);
  await shutdown();
  process.exit(1);
}

function configureDataRoot(): void {
  const rawDataRoot = process.env.DATA_ROOT?.trim();

  if (!rawDataRoot) {
    return;
  }

  const dataRoot = path.resolve(rawDataRoot);
  mkdirSync(dataRoot, { recursive: true });

  if (!process.env.DATABASE_URL || process.env.DATABASE_URL === "file:./dev.db") {
    process.env.DATABASE_URL = `file:${path.join(dataRoot, "koc-dashboard.db")}`;
  }
  process.env.STORAGE_DIR ??= path.join(dataRoot, "storage");
}
