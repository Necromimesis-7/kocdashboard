import "./env";
import { analyzeTranscript, buildProjectReport } from "@koc-dashboard/ai";
import { PrismaClient } from "@koc-dashboard/db";
import { computeNextFetchAt } from "./schedule";
import { loadTranscriptForVideo } from "./transcript";
import { fetchLatestVideos, resolveChannel } from "./youtube";

process.env.DATABASE_URL ??= "file:./dev.db";

const AUTO_FETCH_LIMIT = Number(process.env.AUTO_FETCH_LIMIT ?? 20);

export const prisma = new PrismaClient();

export async function claimNextJob() {
  const now = new Date();
  const job = await prisma.job.findFirst({
    where: {
      status: "pending",
      OR: [
        {
          runAfter: null
        },
        {
          runAfter: {
            lte: now
          }
        }
      ]
    },
    orderBy: [
      {
        priority: "desc"
      },
      {
        createdAt: "asc"
      }
    ]
  });

  if (!job) {
    return null;
  }

  const claimed = await prisma.job.updateMany({
    where: {
      id: job.id,
      status: "pending"
    },
    data: {
      status: "processing",
      startedAt: now,
      errorMessage: null
    }
  });

  if (claimed.count === 0) {
    return null;
  }

  return prisma.job.findUnique({
    where: {
      id: job.id
    }
  });
}

export async function processJob(job: NonNullable<Awaited<ReturnType<typeof claimNextJob>>>): Promise<void> {
  try {
    if (job.type === "resolve_channel") {
      await processResolveChannelJob(job.payloadJson);
    } else if (job.type === "sync_channel") {
      await processSyncChannelJob(job.payloadJson);
    } else if (job.type === "analyze_video") {
      await processAnalyzeVideoJob(job.payloadJson);
    } else if (job.type === "generate_project_report") {
      await processGenerateProjectReportJob(job.payloadJson);
    } else {
      throw new Error(`未知任务类型：${job.type}`);
    }

    await prisma.job.update({
      where: {
        id: job.id
      },
      data: {
        status: "done",
        finishedAt: new Date()
      }
    });
  } catch (error) {
    await prisma.job.update({
      where: {
        id: job.id
      },
      data: {
        status: "failed",
        errorMessage: truncateMessage(errorToMessage(error)),
        finishedAt: new Date()
      }
    });
    throw error;
  }
}

export async function scheduleDueAutoFetches(): Promise<number> {
  const now = new Date();
  const dueChannels = await prisma.kocChannel.findMany({
    where: {
      autoFetchEnabled: true,
      metadataStatus: "done",
      OR: [
        {
          nextFetchAt: null
        },
        {
          nextFetchAt: {
            lte: now
          }
        }
      ]
    },
    orderBy: [
      {
        nextFetchAt: "asc"
      },
      {
        createdAt: "asc"
      }
    ],
    take: 20
  });

  let scheduled = 0;

  for (const channel of dueChannels) {
    const existingJob = await prisma.job.findFirst({
      where: {
        type: "sync_channel",
        status: {
          in: ["pending", "processing"]
        },
        payloadJson: {
          contains: channel.id
        }
      }
    });

    if (existingJob) {
      continue;
    }

    await prisma.job.create({
      data: {
        type: "sync_channel",
        payloadJson: JSON.stringify({
          channelId: channel.id,
          triggerType: "auto"
        })
      }
    });

    await prisma.kocChannel.update({
      where: {
        id: channel.id
      },
      data: {
        lastFetchStatus: "pending",
        lastFetchError: null
      }
    });

    scheduled += 1;
  }

  return scheduled;
}

async function processResolveChannelJob(payloadJson: string): Promise<void> {
  const payload = parsePayload(payloadJson);
  const channelId = readRequiredString(payload, "channelId");
  const channel = await prisma.kocChannel.findUnique({
    where: {
      id: channelId
    }
  });

  if (!channel) {
    throw new Error(`KOC 频道不存在：${channelId}`);
  }

  await prisma.kocChannel.update({
    where: {
      id: channel.id
    },
    data: {
      metadataStatus: "processing",
      metadataError: null
    }
  });

  try {
    const resolved = await resolveChannel(channel.channelUrl);
    const now = new Date();

    await prisma.kocChannel.update({
      where: {
        id: channel.id
      },
      data: {
        channelUrl: resolved.canonicalUrl,
        channelId: resolved.channelId,
        channelName: resolved.channelName,
        metadataStatus: "done",
        metadataError: null,
        nextFetchAt: channel.autoFetchEnabled
          ? (channel.nextFetchAt ?? computeNextFetchAt(channel.fetchFrequency, now))
          : null
      }
    });
  } catch (error) {
    await prisma.kocChannel.update({
      where: {
        id: channel.id
      },
      data: {
        metadataStatus: "failed",
        metadataError: truncateMessage(errorToMessage(error))
      }
    });
    throw error;
  }
}

async function processSyncChannelJob(payloadJson: string): Promise<void> {
  const payload = parsePayload(payloadJson);
  const channelId = readRequiredString(payload, "channelId");
  const triggerType = readOptionalString(payload, "triggerType") === "auto" ? "auto" : "manual";
  const channel = await prisma.kocChannel.findUnique({
    where: {
      id: channelId
    }
  });

  if (!channel) {
    throw new Error(`KOC 频道不存在：${channelId}`);
  }

  const fetchRun = await prisma.fetchRun.create({
    data: {
      kocChannelId: channel.id,
      triggerType,
      status: "processing"
    }
  });

  await prisma.kocChannel.update({
    where: {
      id: channel.id
    },
    data: {
      lastFetchStatus: "processing",
      lastFetchError: null
    }
  });

  try {
    const videos = await fetchLatestVideos(channel.channelUrl, {
      limit: triggerType === "manual" ? 1 : AUTO_FETCH_LIMIT,
      since: triggerType === "manual" ? null : channel.lastFetchedAt
    });
    let videosEnqueued = 0;

    for (const video of videos) {
      const existingVideo = await prisma.video.findUnique({
        where: {
          projectId_youtubeVideoId: {
            projectId: channel.projectId,
            youtubeVideoId: video.youtubeVideoId
          }
        }
      });

      if (existingVideo) {
        const updatedVideo = await prisma.video.update({
          where: {
            id: existingVideo.id
          },
          data: {
            title: video.title,
            youtubeUrl: video.youtubeUrl,
            publishedAt: video.publishedAt,
            durationSeconds: video.durationSeconds,
            channelName: video.channelName ?? channel.channelName,
            kocName: channel.kocName
          }
        });
        if (triggerType === "manual" || updatedVideo.analysisStatus === "pending" || updatedVideo.analysisStatus === "failed") {
          await enqueueAnalyzeVideoJob(updatedVideo.id);
          videosEnqueued += 1;
        }
        continue;
      }

      const createdVideo = await prisma.video.create({
        data: {
          projectId: channel.projectId,
          kocChannelId: channel.id,
          youtubeUrl: video.youtubeUrl,
          youtubeVideoId: video.youtubeVideoId,
          title: video.title,
          channelName: video.channelName ?? channel.channelName,
          kocName: channel.kocName,
          publishedAt: video.publishedAt,
          durationSeconds: video.durationSeconds
        }
      });

      await enqueueAnalyzeVideoJob(createdVideo.id);

      videosEnqueued += 1;
    }

    const finishedAt = new Date();

    await prisma.fetchRun.update({
      where: {
        id: fetchRun.id
      },
      data: {
        status: "done",
        videosFound: videos.length,
        videosEnqueued,
        finishedAt
      }
    });

    await prisma.kocChannel.update({
      where: {
        id: channel.id
      },
      data: {
        lastFetchedAt: finishedAt,
        nextFetchAt: nextFetchAfterSync(channel, triggerType, finishedAt),
        lastFetchStatus: "done",
        lastFetchError: null
      }
    });
  } catch (error) {
    const finishedAt = new Date();

    await prisma.fetchRun.update({
      where: {
        id: fetchRun.id
      },
      data: {
        status: "failed",
        errorMessage: truncateMessage(errorToMessage(error)),
        finishedAt
      }
    });

    await prisma.kocChannel.update({
      where: {
        id: channel.id
      },
      data: {
        nextFetchAt: channel.autoFetchEnabled ? computeNextFetchAt(channel.fetchFrequency, finishedAt) : null,
        lastFetchStatus: "failed",
        lastFetchError: truncateMessage(errorToMessage(error))
      }
    });

    throw error;
  }
}

async function processAnalyzeVideoJob(payloadJson: string): Promise<void> {
  const payload = parsePayload(payloadJson);
  const videoId = readRequiredString(payload, "videoId");
  const video = await prisma.video.findUnique({
    where: {
      id: videoId
    },
    include: {
      project: {
        include: {
          keywords: true
        }
      },
      kocChannel: true,
      transcriptSegments: {
        orderBy: {
          startTimeSeconds: "asc"
        }
      }
    }
  });

  if (!video) {
    throw new Error(`视频不存在：${videoId}`);
  }

  await prisma.video.update({
    where: {
      id: video.id
    },
    data: {
      transcriptStatus: "processing",
      transcriptFailureReason: null,
      analysisStatus: "processing",
      analysisFailureReason: null
    }
  });

  let transcriptLoaded = false;
  let transcriptSource: "youtube_caption" | "audio_transcription" | null = null;

  try {
    const transcript = video.transcriptSegments.length
      ? {
          source: video.transcriptSource ?? "youtube_caption",
          segments: video.transcriptSegments.map((segment) => ({
            id: segment.id,
            startTimeSeconds: segment.startTimeSeconds,
            endTimeSeconds: segment.endTimeSeconds,
            text: segment.text,
            sourceLanguage: segment.sourceLanguage,
            textZh: segment.textZh
          }))
        }
      : await loadTranscriptForVideo(video);
    transcriptLoaded = true;
    transcriptSource = transcript.source;
    const analysis = await analyzeTranscript({
      productName: video.project.productName,
      keywords: video.project.keywords.map((keyword) => keyword.keyword),
      segments: transcript.segments
    });

    await prisma.$transaction(async (tx) => {
      await clearExistingAnalysis(tx, video.id);

      const segmentIdMap = new Map<string, string>();

      for (const segment of analysis.segments) {
        const createdSegment = await tx.transcriptSegment.create({
          data: {
            videoId: video.id,
            startTimeSeconds: segment.startTimeSeconds,
            endTimeSeconds: segment.endTimeSeconds,
            text: segment.text,
            sourceLanguage: segment.sourceLanguage,
            textZh: segment.textZh,
            sourceType: transcript.source,
            isProductRelated: segment.isProductRelated,
            relevanceReason: segment.relevanceReason
          }
        });
        segmentIdMap.set(segment.id, createdSegment.id);
      }

      for (const item of analysis.feedback) {
        const evidenceSegmentIds = item.evidenceSegmentIds
          .map((segmentId) => segmentIdMap.get(segmentId))
          .filter((segmentId): segmentId is string => Boolean(segmentId));

        if (!evidenceSegmentIds.length) {
          continue;
        }

        const feedback = await tx.feedbackItem.create({
          data: {
            projectId: video.projectId,
            videoId: video.id,
            polarity: item.polarity,
            importance: item.importance,
            summary: item.summary,
            suggestion: item.suggestion,
            speakerType: item.speakerType,
            confidence: item.confidence
          }
        });

        await tx.feedbackEvidence.createMany({
          data: evidenceSegmentIds.map((transcriptSegmentId) => ({
            feedbackItemId: feedback.id,
            transcriptSegmentId
          }))
        });
      }

      await tx.video.update({
        where: {
          id: video.id
        },
        data: {
          transcriptStatus: "done",
          transcriptSource: transcript.source,
          transcriptFailureReason: null,
          analysisStatus: "done",
          analysisFailureReason: null
        }
      });
    });

    await enqueueProjectReportJob(video.projectId);
  } catch (error) {
    const errorMessage = truncateMessage(errorToMessage(error));
    await prisma.video.update({
      where: {
        id: video.id
      },
      data: transcriptLoaded && transcriptSource
        ? {
            transcriptStatus: "done",
            transcriptSource,
            transcriptFailureReason: null,
            analysisStatus: "failed",
            analysisFailureReason: errorMessage
          }
        : {
            transcriptStatus: "failed",
            transcriptFailureReason: errorMessage,
            analysisStatus: "failed",
            analysisFailureReason: errorMessage
          }
    });
    throw error;
  }
}

async function processGenerateProjectReportJob(payloadJson: string): Promise<void> {
  const payload = parsePayload(payloadJson);
  const projectId = readRequiredString(payload, "projectId");
  const project = await prisma.project.findUnique({
    where: {
      id: projectId
    },
    include: {
      channels: true,
      videos: {
        where: {
          analysisStatus: "done"
        }
      },
      feedbackItems: {
        orderBy: [
          {
            importance: "asc"
          },
          {
            createdAt: "asc"
          }
        ],
        include: {
          video: true,
          evidence: {
            include: {
              transcriptSegment: true
            }
          }
        }
      }
    }
  });

  if (!project) {
    throw new Error(`项目不存在：${projectId}`);
  }

  const latestReport = await prisma.productReport.findFirst({
    where: {
      projectId: project.id
    },
    orderBy: {
      version: "desc"
    }
  });
  const reportText = buildProjectReport({
    productName: project.productName,
    generatedAt: new Date(),
    kocCount: project.channels.length,
    analyzedVideoCount: project.videos.length,
    feedback: project.feedbackItems.map((item) => {
      const evidence = item.evidence[0]?.transcriptSegment;
      return {
        polarity: item.polarity,
        importance: item.importance,
        summary: item.summary,
        suggestion: item.suggestion,
        confidence: item.confidence,
        videoTitle: item.video.title,
        channelName: item.video.channelName ?? item.video.kocName ?? "未知频道",
        evidenceText: evidence?.text ?? "",
        evidenceZh: evidence?.textZh ?? "",
        timestamp: formatSeconds(evidence?.startTimeSeconds ?? 0)
      };
    })
  });

  await prisma.productReport.create({
    data: {
      projectId: project.id,
      reportText,
      version: (latestReport?.version ?? 0) + 1
    }
  });
}

async function enqueueAnalyzeVideoJob(videoId: string): Promise<void> {
  const existingJob = await prisma.job.findFirst({
    where: {
      type: "analyze_video",
      status: {
        in: ["pending", "processing"]
      },
      payloadJson: {
        contains: videoId
      }
    }
  });

  if (existingJob) {
    return;
  }

  await prisma.job.create({
    data: {
      type: "analyze_video",
      payloadJson: JSON.stringify({
        videoId
      })
    }
  });
}

async function enqueueProjectReportJob(projectId: string): Promise<void> {
  const existingJob = await prisma.job.findFirst({
    where: {
      type: "generate_project_report",
      status: {
        in: ["pending", "processing"]
      },
      payloadJson: {
        contains: projectId
      }
    }
  });

  if (existingJob) {
    return;
  }

  await prisma.job.create({
    data: {
      type: "generate_project_report",
      payloadJson: JSON.stringify({
        projectId
      })
    }
  });
}

async function clearExistingAnalysis(
  tx: Omit<
    PrismaClient,
    | "$connect"
    | "$disconnect"
    | "$on"
    | "$transaction"
    | "$use"
    | "$extends"
  >,
  videoId: string
): Promise<void> {
  const [oldFeedback, oldSegments] = await Promise.all([
    tx.feedbackItem.findMany({
      where: {
        videoId
      },
      select: {
        id: true
      }
    }),
    tx.transcriptSegment.findMany({
      where: {
        videoId
      },
      select: {
        id: true
      }
    })
  ]);

  await tx.feedbackEvidence.deleteMany({
    where: {
      OR: [
        {
          feedbackItemId: {
            in: oldFeedback.map((item) => item.id)
          }
        },
        {
          transcriptSegmentId: {
            in: oldSegments.map((item) => item.id)
          }
        }
      ]
    }
  });
  await tx.feedbackItem.deleteMany({
    where: {
      videoId
    }
  });
  await tx.transcriptSegment.deleteMany({
    where: {
      videoId
    }
  });
}

function nextFetchAfterSync(
  channel: {
    autoFetchEnabled: boolean;
    fetchFrequency: "daily" | "every_2_days" | "weekly" | null;
    nextFetchAt: Date | null;
  },
  triggerType: "auto" | "manual",
  finishedAt: Date
): Date | null {
  if (!channel.autoFetchEnabled) {
    return null;
  }

  if (triggerType === "manual" && channel.nextFetchAt) {
    return channel.nextFetchAt;
  }

  return computeNextFetchAt(channel.fetchFrequency, finishedAt);
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    throw new Error(`任务 payload 不是有效 JSON：${errorToMessage(error)}`);
  }

  throw new Error("任务 payload 必须是对象。");
}

function readRequiredString(payload: Record<string, unknown>, key: string): string {
  const value = readOptionalString(payload, key);

  if (!value) {
    throw new Error(`任务 payload 缺少字段：${key}`);
  }

  return value;
}

function readOptionalString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateMessage(message: string): string {
  return message.slice(0, 2000);
}

function formatSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
}
