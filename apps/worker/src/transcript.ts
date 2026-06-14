import "./env";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runYtDlpCommand } from "./youtube";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const storageRoot = process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR) : path.join(repoRoot, "storage");
const transcriptsDir = path.join(storageRoot, "transcripts");
const audioDir = path.join(storageRoot, "audio");

export interface LoadedTranscriptSegment {
  id: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  text: string;
  sourceLanguage: string | null;
  textZh: string | null;
}

export interface LoadedTranscript {
  source: "youtube_caption" | "audio_transcription";
  segments: LoadedTranscriptSegment[];
}

export async function loadTranscriptForVideo(video: {
  id: string;
  youtubeUrl: string;
  youtubeVideoId: string;
  title: string;
  durationSeconds: number | null;
}): Promise<LoadedTranscript> {
  await Promise.all([mkdir(transcriptsDir, { recursive: true }), mkdir(audioDir, { recursive: true })]);

  const subtitleTranscript = await tryLoadYoutubeCaptions(video);
  if (subtitleTranscript.segments.length > 0) {
    return subtitleTranscript;
  }

  const audioPath = await downloadAudio(video);
  const transcribedText = await transcribeAudio(audioPath, video.title);
  const segments = segmentPlainText(transcribedText, video.durationSeconds ?? 0).map((segment, index) => ({
    ...segment,
    id: `audio_${index}`,
    sourceLanguage: null,
    textZh: null
  }));

  if (!segments.length) {
    throw new Error("音频转写结果为空。");
  }

  return {
    source: "audio_transcription",
    segments
  };
}

async function tryLoadYoutubeCaptions(video: {
  youtubeUrl: string;
  youtubeVideoId: string;
}): Promise<LoadedTranscript> {
  const safeId = safeFileName(video.youtubeVideoId);
  await removeExistingFiles(transcriptsDir, safeId);

  try {
    await runYtDlpCommand([
      "--skip-download",
      "--no-playlist",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      "en.*,en,zh.*,zh,ja.*,ja,ko.*,ko",
      "--sub-format",
      "vtt",
      "-o",
      path.join(transcriptsDir, `${safeId}.%(ext)s`),
      video.youtubeUrl
    ]);
  } catch (error) {
    console.warn(`YouTube 字幕获取失败，将尝试音频转写：${error instanceof Error ? error.message : String(error)}`);
  }

  const subtitleFiles = await findGeneratedFiles(transcriptsDir, safeId, ".vtt");
  const preferredFile = choosePreferredSubtitleFile(subtitleFiles);

  if (!preferredFile) {
    return {
      source: "youtube_caption",
      segments: []
    };
  }

  const content = await readFile(path.join(transcriptsDir, preferredFile), "utf8");
  const sourceLanguage = parseLanguageFromSubtitleFile(preferredFile);
  const segments = compactCues(parseVtt(content), sourceLanguage).map((segment, index) => ({
    ...segment,
    id: `caption_${index}`,
    textZh: null
  }));

  return {
    source: "youtube_caption",
    segments
  };
}

async function downloadAudio(video: {
  youtubeUrl: string;
  youtubeVideoId: string;
}): Promise<string> {
  if (!process.env.AI_API_KEY && !process.env.LEIHUO_API_KEY && !process.env.OPENAI_API_KEY) {
    throw new Error("未找到 YouTube 字幕，且未配置 AI_API_KEY、LEIHUO_API_KEY 或 OPENAI_API_KEY，无法进行音频转写。");
  }

  const safeId = safeFileName(video.youtubeVideoId);
  await removeExistingFiles(audioDir, safeId);

  await runYtDlpCommand([
    "--no-playlist",
    "-x",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "5",
    "-o",
    path.join(audioDir, `${safeId}.%(ext)s`),
    video.youtubeUrl
  ]);

  const files = await findGeneratedFiles(audioDir, safeId, ".mp3");
  const audioFile = files[0];

  if (!audioFile) {
    throw new Error("音频下载完成后未找到 mp3 文件。");
  }

  return path.join(audioDir, audioFile);
}

async function transcribeAudio(audioPath: string, videoTitle: string): Promise<string> {
  const apiKey = process.env.AI_API_KEY || process.env.LEIHUO_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("未配置 AI_API_KEY、LEIHUO_API_KEY 或 OPENAI_API_KEY，无法音频转写。");
  }

  const audioBytes = await readFile(audioPath);
  const formData = new FormData();
  formData.append("file", new Blob([audioBytes], { type: "audio/mpeg" }), path.basename(audioPath));
  formData.append("model", process.env.AI_TRANSCRIPTION_MODEL || process.env.LEIHUO_TRANSCRIPTION_MODEL || process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe");
  formData.append("response_format", "json");
  formData.append("prompt", `This is a YouTube KOC video about a game/product. Video title: ${videoTitle}`);

  const defaultBaseUrl = process.env.AI_PROVIDER === "leihuo" ? "https://ai.leihuo.netease.com/v1" : "https://api.openai.com/v1";
  const baseUrl = (process.env.AI_BASE_URL || process.env.LEIHUO_BASE_URL || process.env.OPENAI_BASE_URL || defaultBaseUrl).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData
  });

  if (!response.ok) {
    throw new Error(`OpenAI 音频转写失败：${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    text?: unknown;
  };
  if (typeof payload.text !== "string" || !payload.text.trim()) {
    throw new Error("OpenAI 音频转写未返回 text。");
  }

  return payload.text;
}

interface Cue {
  startTimeSeconds: number;
  endTimeSeconds: number;
  text: string;
}

function parseVtt(content: string): Cue[] {
  const blocks = content.replace(/\r/g, "").split(/\n{2,}/);
  const cues: Cue[] = [];

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length || lines[0] === "WEBVTT" || lines[0].startsWith("NOTE") || lines[0].startsWith("STYLE")) {
      continue;
    }

    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) {
      continue;
    }

    const timing = lines[timingIndex];
    const match = timing.match(/([0-9:.]+)\s+-->\s+([0-9:.]+)/);
    if (!match) {
      continue;
    }

    const text = cleanCaptionText(lines.slice(timingIndex + 1).join(" "));
    if (!text) {
      continue;
    }

    cues.push({
      startTimeSeconds: parseTimestamp(match[1]),
      endTimeSeconds: parseTimestamp(match[2]),
      text
    });
  }

  return cues;
}

function compactCues(cues: Cue[], sourceLanguage: string | null): LoadedTranscriptSegment[] {
  const segments: LoadedTranscriptSegment[] = [];
  let current: Cue | null = null;

  for (const cue of cues) {
    if (!current) {
      current = { ...cue };
      continue;
    }

    const currentCue = current;
    const isDuplicate: boolean = currentCue.text.endsWith(cue.text) || cue.text.endsWith(currentCue.text);
    const mergedText: string = isDuplicate ? currentCue.text : `${currentCue.text} ${cue.text}`.trim();
    const exceedsWindow = cue.endTimeSeconds - currentCue.startTimeSeconds > 35;
    const exceedsLength = mergedText.length > 520;

    if (exceedsWindow || exceedsLength) {
      segments.push({
        id: "",
        startTimeSeconds: currentCue.startTimeSeconds,
        endTimeSeconds: currentCue.endTimeSeconds,
        text: currentCue.text,
        sourceLanguage,
        textZh: null
      });
      current = { ...cue };
      continue;
    }

    current = {
      startTimeSeconds: current.startTimeSeconds,
      endTimeSeconds: cue.endTimeSeconds,
      text: mergedText
    };
  }

  if (current) {
    segments.push({
      id: "",
      startTimeSeconds: current.startTimeSeconds,
      endTimeSeconds: current.endTimeSeconds,
      text: current.text,
      sourceLanguage,
      textZh: null
    });
  }

  return segments.filter((segment) => segment.text.length >= 8).slice(0, 240);
}

function segmentPlainText(text: string, durationSeconds: number): Omit<LoadedTranscriptSegment, "id" | "sourceLanguage" | "textZh">[] {
  const sentences = text
    .split(/(?<=[.!?。！？])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences.length ? sentences : [text]) {
    if (current && `${current} ${sentence}`.length > 520) {
      chunks.push(current);
      current = sentence;
    } else {
      current = `${current} ${sentence}`.trim();
    }
  }

  if (current) {
    chunks.push(current);
  }

  const safeDuration = durationSeconds > 0 ? durationSeconds : chunks.length * 30;
  const windowSize = safeDuration / Math.max(1, chunks.length);

  return chunks.map((chunk, index) => ({
    startTimeSeconds: Math.round(index * windowSize),
    endTimeSeconds: Math.round(Math.min(safeDuration, (index + 1) * windowSize)),
    text: chunk
  }));
}

function cleanCaptionText(text: string): string {
  return decodeHtmlEntities(
    text
      .replace(/<[^>]*>/g, " ")
      .replace(/\[[^\]]*]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseTimestamp(value: string): number {
  const parts = value.replace(",", ".").split(":").map(Number);

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  return 0;
}

async function findGeneratedFiles(directory: string, prefix: string, extension: string): Promise<string[]> {
  const files = await readdir(directory);
  return files.filter((file) => file.startsWith(`${prefix}.`) && file.endsWith(extension)).sort();
}

function choosePreferredSubtitleFile(files: string[]): string | null {
  if (!files.length) {
    return null;
  }

  return (
    files.find((file) => /\.en(?:[-.][^.]+)?\.vtt$/.test(file)) ??
    files.find((file) => /\.zh(?:[-.][^.]+)?\.vtt$/.test(file)) ??
    files[0] ??
    null
  );
}

function parseLanguageFromSubtitleFile(fileName: string): string | null {
  const match = fileName.match(/\.([a-z]{2}(?:-[A-Za-z]+)?)\.vtt$/);
  return match?.[1] ?? null;
}

async function removeExistingFiles(directory: string, prefix: string): Promise<void> {
  const files = await readdir(directory).catch(() => []);
  await Promise.all(
    files
      .filter((file) => file.startsWith(`${prefix}.`))
      .map((file) =>
        rm(path.join(directory, file), {
          force: true
        })
      )
  );
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
