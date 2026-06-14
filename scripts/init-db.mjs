import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
loadEnvFile(join(rootDir, ".env"));
configureDataRoot();

const schemaPath = join(rootDir, "prisma", "schema.prisma");
const databaseUrl = process.env.DATABASE_URL ?? "file:./dev.db";
const dbPath = sqlitePathFromDatabaseUrl(databaseUrl, dirname(schemaPath));
const shouldReset = process.argv.includes("--reset");

if (existsSync(dbPath) && !shouldReset) {
  console.log(`SQLite database already exists at ${dbPath}`);
  console.log("Use `npm run db:init -- --reset` to recreate it.");
  process.exit(0);
}

if (existsSync(dbPath) && shouldReset) {
  for (const filePath of [dbPath, `${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }
}

mkdirSync(dirname(dbPath), { recursive: true });

const env = {
  ...process.env,
  DATABASE_URL: databaseUrl
};

const diff = spawnSync(
  "npx",
  [
    "prisma",
    "migrate",
    "diff",
    "--from-empty",
    "--to-schema-datamodel",
    schemaPath,
    "--script"
  ],
  {
    cwd: rootDir,
    env,
    encoding: "utf8"
  }
);

if (diff.status !== 0) {
  process.stderr.write(diff.stderr);
  process.exit(diff.status ?? 1);
}

const sqlite = spawnSync("sqlite3", [dbPath], {
  cwd: rootDir,
  input: diff.stdout,
  encoding: "utf8"
});

if (sqlite.status !== 0) {
  process.stderr.write(sqlite.stderr);
  process.exit(sqlite.status ?? 1);
}

const generate = spawnSync("npx", ["prisma", "generate"], {
  cwd: rootDir,
  env,
  encoding: "utf8"
});

if (generate.status !== 0) {
  process.stderr.write(generate.stderr);
  process.exit(generate.status ?? 1);
}

process.stdout.write(generate.stdout);
console.log(`SQLite database initialized at ${dbPath}`);

function sqlitePathFromDatabaseUrl(url, schemaDir) {
  if (!url.startsWith("file:")) {
    throw new Error("scripts/init-db.mjs only supports SQLite DATABASE_URL values that start with file:.");
  }

  if (url.startsWith("file://")) {
    return fileURLToPath(url);
  }

  const rawPath = url.slice("file:".length);
  return rawPath.startsWith("/") ? rawPath : join(schemaDir, rawPath);
}

function configureDataRoot() {
  const rawDataRoot = process.env.DATA_ROOT?.trim();

  if (!rawDataRoot) {
    return;
  }

  const dataRoot = rawDataRoot.startsWith("/") ? rawDataRoot : join(rootDir, rawDataRoot);
  mkdirSync(dataRoot, { recursive: true });

  if (!process.env.DATABASE_URL || process.env.DATABASE_URL === "file:./dev.db") {
    process.env.DATABASE_URL = `file:${join(dataRoot, "koc-dashboard.db")}`;
  }
}

function loadEnvFile(envPath) {
  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, "utf8");

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalizedLine = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separatorIndex = normalizedLine.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    const value = parseEnvValue(normalizedLine.slice(separatorIndex + 1).trim());
    process.env[key] ??= value;
  }
}

function parseEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }

  const hashIndex = value.indexOf(" #");
  return (hashIndex === -1 ? value : value.slice(0, hashIndex)).trim();
}
