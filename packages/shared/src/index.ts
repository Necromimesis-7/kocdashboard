export const DEFAULT_KEYWORDS = [
  "bug",
  "lag",
  "crash",
  "fps",
  "loading",
  "freeze",
  "stutter",
  "paywall",
  "gacha",
  "grind"
] as const;

export const FETCH_FREQUENCIES = ["daily", "every_2_days", "weekly"] as const;

export const POLARITIES = ["positive", "neutral", "negative"] as const;
export const IMPORTANCE_LEVELS = ["high", "medium", "low"] as const;

export type FetchFrequency = (typeof FETCH_FREQUENCIES)[number];
export type Polarity = (typeof POLARITIES)[number];
export type Importance = (typeof IMPORTANCE_LEVELS)[number];

export type AnalysisStatus = "pending" | "processing" | "done" | "failed";
export type TranscriptSource = "youtube_caption" | "audio_transcription";
export type SpeakerType = "koc_self" | "audience_or_community" | "unclear";
export type JobType = "resolve_channel" | "sync_channel" | "analyze_video" | "generate_project_report";

export interface ProjectSummary {
  id: string;
  productName: string;
  productContext: string | null;
  kocCount: number;
  analyzedVideoCount: number;
  updatedAt: string;
}

export interface ProjectStats {
  kocCount: number;
  analyzedVideoCount: number;
  highImportanceCount: number;
  reportVersion: number;
  autoFetchEnabledCount: number;
  negativeRiskCount: number;
}

export interface KocChannelSummary {
  id: string;
  channelName: string;
  channelUrl: string;
  autoFetchEnabled: boolean;
  fetchFrequency: FetchFrequency | null;
  lastFetchedAt: string | null;
  nextFetchAt: string | null;
  metadataStatus: AnalysisStatus;
  metadataError: string | null;
  lastFetchStatus: AnalysisStatus | null;
  lastFetchError: string | null;
  status: AnalysisStatus;
}

export interface VideoSummary {
  id: string;
  title: string;
  channelName: string;
  publishedAt: string;
  transcriptStatus: AnalysisStatus;
  transcriptFailureReason: string | null;
  analysisStatus: AnalysisStatus;
  analysisFailureReason: string | null;
  primaryPolarity: Polarity | null;
  relatedSegmentCount: number;
  highImportanceCount: number;
}

export interface FeedbackItem {
  id: string;
  polarity: Polarity;
  importance: Importance;
  summary: string;
  evidence: string;
  evidenceZh: string;
  timestamp: string;
  sourceVideo: string;
  channelName: string;
}

export interface ProjectReportSummary {
  id: string;
  reportText: string;
  generatedAt: string;
  version: number;
}

export interface JobSummary {
  id: string;
  type: JobType;
  status: AnalysisStatus;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ProjectDashboard {
  project: ProjectSummary;
  keywords: string[];
  stats: ProjectStats;
  channels: KocChannelSummary[];
  videos: VideoSummary[];
  feedback: FeedbackItem[];
  report: ProjectReportSummary | null;
}

export interface ProjectJobsResponse {
  jobs: JobSummary[];
}

export interface CreateProjectInput {
  productName: string;
  productContext?: string;
  keywords?: string[];
}

export interface DeleteProjectResponse {
  deletedProjectId: string;
  nextProjectId: string | null;
}

export interface DeleteKocChannelResponse {
  deletedChannelId: string;
}

export interface CreateKocChannelInput {
  channelUrl: string;
  kocName?: string;
  autoFetchEnabled?: boolean;
  fetchFrequency?: FetchFrequency | null;
  notes?: string;
}
