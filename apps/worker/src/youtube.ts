import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_YT_DLP_PATH = "/opt/homebrew/bin/yt-dlp";
const YOUTUBE_WATCH_BASE_URL = "https://www.youtube.com/watch?v=";
const YOUTUBE_VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

interface YtDlpEntry {
  id?: unknown;
  url?: unknown;
  webpage_url?: unknown;
  title?: unknown;
  channel?: unknown;
  uploader?: unknown;
  duration?: unknown;
  timestamp?: unknown;
  release_timestamp?: unknown;
  upload_date?: unknown;
}

interface YtDlpPlaylist extends YtDlpEntry {
  entries?: unknown;
  channel_id?: unknown;
  uploader_id?: unknown;
  channel_url?: unknown;
  uploader_url?: unknown;
}

export interface ResolvedChannel {
  channelId: string | null;
  channelName: string | null;
  canonicalUrl: string;
}

export interface FetchedVideo {
  youtubeVideoId: string;
  youtubeUrl: string;
  title: string;
  channelName: string | null;
  publishedAt: Date | null;
  durationSeconds: number | null;
}

export async function resolveChannel(channelUrl: string): Promise<ResolvedChannel> {
  const data = await runYtDlpJson(channelUrl, ["--flat-playlist", "--playlist-end", "1"]);

  return {
    channelId: firstString(data.channel_id, data.uploader_id, data.id),
    channelName: firstString(data.channel, data.uploader, data.title),
    canonicalUrl: firstString(data.channel_url, data.uploader_url, data.webpage_url) ?? channelUrl
  };
}

export async function fetchLatestVideos(
  channelUrl: string,
  options: {
    limit: number;
    since?: Date | null;
  }
): Promise<FetchedVideo[]> {
  const limit = Math.max(1, options.limit);
  const data = await runYtDlpJson(toChannelVideosUrl(channelUrl), ["--flat-playlist", "--playlist-end", String(limit)]);
  const entries = normalizeEntries(data);

  return entries
    .map((entry) => mapVideo(entry, data))
    .filter((video): video is FetchedVideo => {
      if (!video) {
        return false;
      }

      if (!options.since || !video.publishedAt) {
        return true;
      }

      return video.publishedAt > options.since;
    });
}

async function runYtDlpJson(channelUrl: string, args: string[]): Promise<YtDlpPlaylist> {
  return parseJsonOutput(await runYtDlpCommand(["-J", "--no-warnings", ...args, channelUrl]));
}

export async function runYtDlpCommand(args: string[]): Promise<string> {
  const binary = process.env.YT_DLP_PATH ?? DEFAULT_YT_DLP_PATH;
  const commandArgs = withYtDlpRuntimeArgs(args);

  try {
    return await execYtDlp(binary, commandArgs);
  } catch (error) {
    if (binary === DEFAULT_YT_DLP_PATH && isMissingExecutable(error)) {
      return await execYtDlp("yt-dlp", commandArgs);
    }

    throw error;
  }
}

function withYtDlpRuntimeArgs(args: string[]): string[] {
  const runtimeArgs: string[] = [];
  const cookiesPath = process.env.YT_DLP_COOKIES_PATH?.trim();
  const jsRuntime = process.env.YT_DLP_JS_RUNTIME?.trim();
  const remoteComponents = process.env.YT_DLP_REMOTE_COMPONENTS?.trim();

  if (cookiesPath) {
    runtimeArgs.push("--cookies", cookiesPath);
  }

  if (jsRuntime) {
    runtimeArgs.push("--js-runtimes", jsRuntime);
  }

  if (remoteComponents) {
    runtimeArgs.push("--remote-components", remoteComponents);
  }

  return [...runtimeArgs, ...args];
}

async function execYtDlp(binary: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(binary, args, {
      maxBuffer: 30 * 1024 * 1024,
      timeout: Number(process.env.YT_DLP_TIMEOUT_MS ?? 120_000)
    });
    return stdout;
  } catch (error) {
    throw new Error(`yt-dlp 执行失败：${formatProcessError(error)}`);
  }
}

function parseJsonOutput(stdout: string): YtDlpPlaylist {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as YtDlpPlaylist;
    }
  } catch (error) {
    throw new Error(`yt-dlp 返回内容不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }

  throw new Error("yt-dlp 返回内容为空。");
}

function normalizeEntries(data: YtDlpPlaylist): YtDlpEntry[] {
  if (Array.isArray(data.entries)) {
    return data.entries.filter((entry): entry is YtDlpEntry => Boolean(entry && typeof entry === "object"));
  }

  return [data];
}

function mapVideo(entry: YtDlpEntry, playlist: YtDlpPlaylist): FetchedVideo | null {
  const id = extractVideoId(firstString(entry.id, entry.webpage_url, entry.url));

  if (!id) {
    return null;
  }

  const rawUrl = firstString(entry.webpage_url, entry.url);
  const youtubeUrl = rawUrl?.startsWith("http") ? rawUrl : `${YOUTUBE_WATCH_BASE_URL}${id}`;

  return {
    youtubeVideoId: id,
    youtubeUrl,
    title: firstString(entry.title) ?? "未命名视频",
    channelName: firstString(entry.channel, entry.uploader, playlist.channel, playlist.uploader, playlist.title),
    publishedAt: parsePublishedAt(entry),
    durationSeconds: parseDurationSeconds(entry.duration)
  };
}

function extractVideoId(raw: string | null): string | null {
  if (!raw) {
    return null;
  }

  if (YOUTUBE_VIDEO_ID_PATTERN.test(raw) && !raw.includes("/")) {
    return raw;
  }

  try {
    const url = new URL(raw);
    const watchId = url.searchParams.get("v");

    if (watchId) {
      return watchId;
    }

    const pathParts = url.pathname.split("/").filter(Boolean);
    const shortId = url.hostname.includes("youtu.be") ? pathParts[0] : pathParts[pathParts.length - 1];
    return shortId && YOUTUBE_VIDEO_ID_PATTERN.test(shortId) ? shortId : null;
  } catch {
    return null;
  }
}

function toChannelVideosUrl(channelUrl: string): string {
  try {
    const url = new URL(channelUrl);

    if (!isYoutubeHost(url.hostname) || url.pathname.includes("/watch")) {
      return channelUrl;
    }

    const pathParts = url.pathname.split("/").filter(Boolean);
    const lastPart = pathParts[pathParts.length - 1];
    const knownTabs = new Set(["videos", "shorts", "streams"]);

    if (!lastPart || knownTabs.has(lastPart)) {
      return channelUrl;
    }

    url.pathname = `${url.pathname.replace(/\/+$/, "")}/videos`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return channelUrl;
  }
}

function isYoutubeHost(hostname: string): boolean {
  return hostname === "youtube.com" || hostname === "www.youtube.com" || hostname === "m.youtube.com";
}

function parsePublishedAt(entry: YtDlpEntry): Date | null {
  const timestamp = numericValue(entry.timestamp) ?? numericValue(entry.release_timestamp);

  if (timestamp) {
    return new Date(timestamp * 1000);
  }

  const uploadDate = firstString(entry.upload_date);

  if (uploadDate && /^\d{8}$/.test(uploadDate)) {
    const year = uploadDate.slice(0, 4);
    const month = uploadDate.slice(4, 6);
    const day = uploadDate.slice(6, 8);
    return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  }

  return null;
}

function parseDurationSeconds(raw: unknown): number | null {
  const value = numericValue(raw);
  return value === null ? null : Math.round(value);
}

function numericValue(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }

  if (typeof raw === "string" && raw.trim()) {
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function isMissingExecutable(error: unknown): boolean {
  return error instanceof Error && error.message.includes("ENOENT");
}

function formatProcessError(error: unknown): string {
  if (error && typeof error === "object") {
    const processError = error as {
      message?: string;
      stderr?: string;
      stdout?: string;
    };
    return [processError.message, processError.stderr, processError.stdout].filter(Boolean).join("\n").slice(0, 2000);
  }

  return String(error);
}
