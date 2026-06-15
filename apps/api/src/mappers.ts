import type { PrismaClient } from "@koc-dashboard/db";
import type { FeedbackItem, KocChannelSummary, ProjectDashboard, ProjectSummary, VideoSummary } from "@koc-dashboard/shared";

type ProjectWithCounts = Awaited<ReturnType<PrismaClient["project"]["findMany"]>>[number] & {
  _count: {
    channels: number;
    videos: number;
  };
};

export function mapProjectSummary(project: ProjectWithCounts): ProjectSummary {
  return {
    id: project.id,
    productName: project.productName,
    productContext: project.productContext,
    kocCount: project._count.channels,
    analyzedVideoCount: project._count.videos,
    updatedAt: project.updatedAt.toISOString()
  };
}

export function mapChannelSummary(channel: {
  id: string;
  channelName: string | null;
  channelUrl: string;
  kocName: string | null;
  autoFetchEnabled: boolean;
  fetchFrequency: "daily" | "every_2_days" | "weekly" | null;
  lastFetchedAt: Date | null;
  nextFetchAt: Date | null;
  lastFetchStatus: "pending" | "processing" | "done" | "failed" | null;
  lastFetchError: string | null;
  metadataStatus: "pending" | "processing" | "done" | "failed";
  metadataError: string | null;
}): KocChannelSummary {
  return {
    id: channel.id,
    channelName: channel.channelName ?? channel.kocName ?? "未解析频道",
    channelUrl: channel.channelUrl,
    autoFetchEnabled: channel.autoFetchEnabled,
    fetchFrequency: channel.fetchFrequency,
    lastFetchedAt: channel.lastFetchedAt?.toISOString() ?? null,
    nextFetchAt: channel.nextFetchAt?.toISOString() ?? null,
    metadataStatus: channel.metadataStatus,
    metadataError: channel.metadataError,
    lastFetchStatus: channel.lastFetchStatus,
    lastFetchError: channel.lastFetchError,
    status: channel.lastFetchStatus ?? channel.metadataStatus
  };
}

export function mapVideoSummary(video: {
  id: string;
  title: string;
  channelName: string | null;
  kocName: string | null;
  publishedAt: Date | null;
  transcriptStatus: "pending" | "processing" | "done" | "failed";
  transcriptFailureReason: string | null;
  analysisStatus: "pending" | "processing" | "done" | "failed";
  analysisFailureReason: string | null;
  feedbackItems: {
    polarity: "positive" | "neutral" | "negative";
    importance: "high" | "medium" | "low";
  }[];
  transcriptSegments: {
    isProductRelated: boolean;
  }[];
}): VideoSummary {
  const polarityCounts = video.feedbackItems.reduce<Record<string, number>>((acc, item) => {
    acc[item.polarity] = (acc[item.polarity] ?? 0) + 1;
    return acc;
  }, {});
  const primaryPolarity = Object.entries(polarityCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const relatedSegmentCount = video.transcriptSegments.filter((segment) => segment.isProductRelated).length;

  return {
    id: video.id,
    title: video.title,
    channelName: video.channelName ?? video.kocName ?? "未知频道",
    publishedAt: video.publishedAt?.toISOString().slice(0, 10) ?? "未知",
    transcriptStatus: video.transcriptStatus,
    transcriptFailureReason: video.transcriptFailureReason,
    analysisStatus: video.analysisStatus,
    analysisFailureReason: video.analysisFailureReason,
    primaryPolarity: primaryPolarity as VideoSummary["primaryPolarity"],
    relatedSegmentCount,
    highImportanceCount: video.feedbackItems.filter((item) => item.importance === "high").length,
    noFeedbackReason: buildNoFeedbackReason(video, relatedSegmentCount)
  };
}

function buildNoFeedbackReason(
  video: {
    transcriptStatus: "pending" | "processing" | "done" | "failed";
    analysisStatus: "pending" | "processing" | "done" | "failed";
    feedbackItems: unknown[];
    transcriptSegments: unknown[];
  },
  relatedSegmentCount: number
): string | null {
  if (video.analysisStatus !== "done" || video.feedbackItems.length > 0) {
    return null;
  }

  if (video.transcriptStatus === "done" && video.transcriptSegments.length === 0) {
    return "已分析，但未获取到可用字幕片段。";
  }

  if (relatedSegmentCount === 0) {
    return "已分析，但未检测到与当前项目明确相关的产品反馈。";
  }

  return "已检测到相关片段，但未形成可报告的明确反馈。";
}

export function mapFeedbackItem(item: {
  id: string;
  polarity: "positive" | "neutral" | "negative";
  importance: "high" | "medium" | "low";
  summary: string;
  video: {
    title: string;
    channelName: string | null;
    kocName: string | null;
  };
  evidence: {
    transcriptSegment: {
      startTimeSeconds: number;
      text: string;
      textZh: string | null;
    };
  }[];
}): FeedbackItem {
  const evidence = item.evidence[0]?.transcriptSegment;
  return {
    id: item.id,
    polarity: item.polarity,
    importance: item.importance,
    summary: toChineseSummary(item.summary),
    evidence: evidence?.text ?? "",
    evidenceZh: toChineseEvidence(evidence?.textZh ?? ""),
    timestamp: formatSeconds(evidence?.startTimeSeconds ?? 0),
    sourceVideo: item.video.title,
    channelName: item.video.channelName ?? item.video.kocName ?? "未知频道"
  };
}

export function buildDashboardResponse(data: {
  project: ProjectWithCounts;
  keywords: string[];
  channels: ReturnType<typeof mapChannelSummary>[];
  videos: ReturnType<typeof mapVideoSummary>[];
  feedback: ReturnType<typeof mapFeedbackItem>[];
  report: {
    id: string;
    reportText: string;
    generatedAt: Date;
    version: number;
  } | null;
}): ProjectDashboard {
  return {
    project: mapProjectSummary(data.project),
    keywords: data.keywords,
    stats: {
      kocCount: data.channels.length,
      analyzedVideoCount: data.videos.filter((video) => video.analysisStatus === "done").length,
      highImportanceCount: data.feedback.filter((item) => item.importance === "high").length,
      reportVersion: data.report?.version ?? 0,
      autoFetchEnabledCount: data.channels.filter((channel) => channel.autoFetchEnabled).length,
      negativeRiskCount: data.feedback.filter((item) => item.polarity === "negative").length
    },
    channels: data.channels,
    videos: data.videos,
    feedback: data.feedback,
    report: data.report
      ? {
          id: data.report.id,
          reportText: toChineseReportText(data.report.reportText),
          generatedAt: data.report.generatedAt.toISOString(),
          version: data.report.version
        }
      : null
  };
}

function formatSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function toChineseSummary(summary: string): string {
  return toChineseOnlyText(summary
    .replace(/：「[^」]*」/g, "。")
    .replace(/:"[^"]*"/g, "。")
  );
}

function toChineseEvidence(evidenceZh: string): string {
  const cleaned = toChineseOnlyText(evidenceZh);
  return cleaned || "该证据的中文翻译待补充。";
}

function toChineseReportText(reportText: string): string {
  let isEvidenceIndex = false;

  return reportText
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "八、证据索引") {
        isEvidenceIndex = true;
        return line;
      }

      if (/^[一二三四五六七九十]+、/.test(trimmed) && trimmed !== "八、证据索引") {
        isEvidenceIndex = false;
      }

      const withoutQuotedEvidence = line
        .replace(/：「[^」]*」/g, "。")
        .replace(/:"[^"]*"/g, "。")
        .replace(/。。+/g, "。");

      if (isEvidenceIndex && /^\d+\./.test(trimmed) && !withoutQuotedEvidence.includes("中文摘要：")) {
        const timestampPrefix = withoutQuotedEvidence.match(/^(\d+\..*? \/ \d{2}:\d{2})/);
        return timestampPrefix ? `${timestampPrefix[1]} / 中文摘要：该证据原文已在详情保留。` : "中文摘要：该证据原文已在详情保留。";
      }

      if (withoutQuotedEvidence.includes("中文证据：")) {
        return withoutQuotedEvidence.replace(/中文证据：.*$/, "中文摘要：该证据原文已在详情保留。");
      }

      return withoutQuotedEvidence.trimEnd();
    })
    .join("\n");
}

function toChineseOnlyText(value: string): string {
  return value
    .replace(/(该片段(?:提到|是|需要)[^：。]*)(?:：.*)?$/g, "$1。")
    .split(/(?<=[。！？；;])|\n/)
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) {
        return false;
      }

      const latinChars = (part.match(/[A-Za-z]/g) ?? []).length;
      const cjkChars = (part.match(/[\u3400-\u9fff]/g) ?? []).length;
      return cjkChars > 0 || latinChars <= 12;
    })
    .join("")
    .replace(/。。+/g, "。")
    .trim();
}
