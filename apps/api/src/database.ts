import "./env";
import { PrismaClient } from "@koc-dashboard/db";
import { DEFAULT_KEYWORDS, type CreateKocChannelInput, type CreateProjectInput } from "@koc-dashboard/shared";

process.env.DATABASE_URL ??= "file:./dev.db";

export const prisma = new PrismaClient();

const demoReportText = `【KOC 项目反馈摘要】
产品/游戏：Project Aurora
分析范围：当前项目下所有已分析 KOC 视频
KOC 数量：3
视频数量：3
分析日期：2026-06-09

一、数据范围说明
- 本次报告覆盖 3 个 KOC、3 条已分析视频。
- 本报告只代表当前项目已分析内容，不代表全网结论。

二、整体结论
- 当前 KOC 反馈整体偏正向，但性能和商业化压力是需要优先核查的风险。

三、正面反馈汇总
1. 新角色战斗表现被多位 KOC 认可。
代表证据：PixelArena / 版本更新后战斗体验实测 / 04:12 / "the kit feels responsive" / “技能组反馈很跟手”

四、中性观察汇总
1. KOC 普遍先解释活动奖励和养成路径。

五、负面反馈 / 风险汇总
1. 战斗场景卡顿和加载时间被重复提到。

六、高频问题 / 高频观点
1. 性能稳定性：2 个 KOC / 2 条视频提到。

七、产品可考虑建议
1. 优先排查战斗场景帧率和加载链路。
来源类型：基于反馈推导

八、证据索引
1. PixelArena / 版本更新后战斗体验实测 / 04:12 / "the kit feels responsive, but I am seeing drops when the arena gets crowded" / “技能组反馈很跟手，但竞技场单位变多时会掉帧。”`;

export async function ensureDemoData() {
  const existingProject = await prisma.project.findFirst({
    orderBy: {
      createdAt: "asc"
    }
  });

  if (existingProject) {
    return existingProject;
  }

  return prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        productName: "Project Aurora",
        productContext: "用于演示 KOC YouTube 产品反馈分析流程的示例项目。",
        keywords: {
          create: DEFAULT_KEYWORDS.map((keyword) => ({
            keyword,
            source: "default"
          }))
        }
      }
    });

    const pixelArena = await tx.kocChannel.create({
      data: {
        projectId: project.id,
        channelUrl: "https://youtube.com/@pixelarena",
        channelId: "UC_PIXEL_ARENA",
        channelName: "PixelArena",
        kocName: "PixelArena",
        metadataStatus: "done",
        autoFetchEnabled: true,
        fetchFrequency: "daily",
        lastFetchedAt: new Date("2026-06-09T01:00:00.000Z"),
        nextFetchAt: new Date("2026-06-10T01:00:00.000Z"),
        lastFetchStatus: "done"
      }
    });

    const jrpgNotes = await tx.kocChannel.create({
      data: {
        projectId: project.id,
        channelUrl: "https://youtube.com/@jrpgnotes",
        channelId: "UC_JRPG_NOTES",
        channelName: "JRPG Notes",
        kocName: "JRPG Notes",
        metadataStatus: "done",
        autoFetchEnabled: true,
        fetchFrequency: "every_2_days",
        lastFetchedAt: new Date("2026-06-08T10:20:00.000Z"),
        nextFetchAt: new Date("2026-06-10T10:20:00.000Z"),
        lastFetchStatus: "processing"
      }
    });

    const gachaLab = await tx.kocChannel.create({
      data: {
        projectId: project.id,
        channelUrl: "https://youtube.com/@gachalab",
        channelId: "UC_GACHA_LAB",
        channelName: "Gacha Lab",
        kocName: "Gacha Lab",
        metadataStatus: "done",
        autoFetchEnabled: false,
        lastFetchedAt: new Date("2026-06-07T13:14:00.000Z"),
        lastFetchStatus: "done"
      }
    });

    const videoOne = await tx.video.create({
      data: {
        projectId: project.id,
        kocChannelId: pixelArena.id,
        youtubeUrl: "https://youtube.com/watch?v=demo_pixel_1",
        youtubeVideoId: "demo_pixel_1",
        title: "版本更新后战斗体验实测",
        channelName: "PixelArena",
        kocName: "PixelArena",
        publishedAt: new Date("2026-06-09T02:30:00.000Z"),
        durationSeconds: 1320,
        transcriptStatus: "done",
        transcriptSource: "youtube_caption",
        analysisStatus: "done"
      }
    });

    const videoTwo = await tx.video.create({
      data: {
        projectId: project.id,
        kocChannelId: jrpgNotes.id,
        youtubeUrl: "https://youtube.com/watch?v=demo_jrpg_1",
        youtubeVideoId: "demo_jrpg_1",
        title: "新角色活动第一小时体验",
        channelName: "JRPG Notes",
        kocName: "JRPG Notes",
        publishedAt: new Date("2026-06-08T06:00:00.000Z"),
        durationSeconds: 980,
        transcriptStatus: "done",
        transcriptSource: "audio_transcription",
        analysisStatus: "done"
      }
    });

    const videoThree = await tx.video.create({
      data: {
        projectId: project.id,
        kocChannelId: gachaLab.id,
        youtubeUrl: "https://youtube.com/watch?v=demo_gacha_1",
        youtubeVideoId: "demo_gacha_1",
        title: "抽卡机制和养成节奏讨论",
        channelName: "Gacha Lab",
        kocName: "Gacha Lab",
        publishedAt: new Date("2026-06-07T11:00:00.000Z"),
        durationSeconds: 1560,
        transcriptStatus: "done",
        transcriptSource: "youtube_caption",
        analysisStatus: "done"
      }
    });

    const segmentOne = await tx.transcriptSegment.create({
      data: {
        videoId: videoOne.id,
        startTimeSeconds: 252,
        endTimeSeconds: 267,
        text: "the kit feels responsive, but I am seeing drops when the arena gets crowded",
        sourceLanguage: "en",
        textZh: "技能组反馈很跟手，但竞技场单位变多时会掉帧。",
        sourceType: "youtube_caption",
        isProductRelated: true,
        relevanceReason: "直接提到战斗手感和掉帧。"
      }
    });

    const segmentTwo = await tx.transcriptSegment.create({
      data: {
        videoId: videoTwo.id,
        startTimeSeconds: 116,
        endTimeSeconds: 131,
        text: "players will probably check the rewards first before deciding how deep to go",
        sourceLanguage: "en",
        textZh: "玩家可能会先看奖励，再决定活动参与深度。",
        sourceType: "audio_transcription",
        isProductRelated: true,
        relevanceReason: "提到活动奖励和玩家参与意愿。"
      }
    });

    const segmentThree = await tx.transcriptSegment.create({
      data: {
        videoId: videoThree.id,
        startTimeSeconds: 488,
        endTimeSeconds: 503,
        text: "the gacha pressure is not terrible, but it is something new players will notice",
        sourceLanguage: "en",
        textZh: "抽卡压力不算糟糕，但新玩家会明显注意到。",
        sourceType: "youtube_caption",
        isProductRelated: true,
        relevanceReason: "提到抽卡压力和新玩家体验。"
      }
    });

    const feedbackOne = await tx.feedbackItem.create({
      data: {
        projectId: project.id,
        videoId: videoOne.id,
        polarity: "negative",
        importance: "high",
        summary: "KOC 认为战斗场景单位变多时出现掉帧，影响操作体验。",
        suggestion: "优先排查战斗场景帧率和卡顿问题。",
        speakerType: "koc_self",
        confidence: 0.91
      }
    });

    const feedbackTwo = await tx.feedbackItem.create({
      data: {
        projectId: project.id,
        videoId: videoTwo.id,
        polarity: "neutral",
        importance: "medium",
        summary: "KOC 观察到玩家会优先关注活动奖励，再决定参与深度。",
        suggestion: "在活动入口更清晰地展示奖励结构。",
        speakerType: "audience_or_community",
        confidence: 0.84
      }
    });

    const feedbackThree = await tx.feedbackItem.create({
      data: {
        projectId: project.id,
        videoId: videoThree.id,
        polarity: "positive",
        importance: "medium",
        summary: "KOC 认为抽卡压力整体可接受，但新玩家会明显感知。",
        suggestion: "继续关注新玩家早期抽卡体验和资源引导。",
        speakerType: "koc_self",
        confidence: 0.79
      }
    });

    await tx.feedbackEvidence.createMany({
      data: [
        {
          feedbackItemId: feedbackOne.id,
          transcriptSegmentId: segmentOne.id
        },
        {
          feedbackItemId: feedbackTwo.id,
          transcriptSegmentId: segmentTwo.id
        },
        {
          feedbackItemId: feedbackThree.id,
          transcriptSegmentId: segmentThree.id
        }
      ]
    });

    await tx.productReport.create({
      data: {
        projectId: project.id,
        reportText: demoReportText,
        version: 1
      }
    });

    return project;
  });
}

export async function createProject(input: CreateProjectInput) {
  const uniqueKeywords = Array.from(new Set([...(input.keywords ?? []), ...DEFAULT_KEYWORDS]));

  return prisma.project.create({
    data: {
      productName: input.productName.trim(),
      productContext: input.productContext?.trim() || null,
      keywords: {
        create: uniqueKeywords.map((keyword) => ({
          keyword,
          source: DEFAULT_KEYWORDS.includes(keyword as (typeof DEFAULT_KEYWORDS)[number]) ? "default" : "user"
        }))
      }
    }
  });
}

export async function createKocChannel(projectId: string, input: CreateKocChannelInput) {
  return prisma.kocChannel.create({
    data: {
      projectId,
      channelUrl: input.channelUrl.trim(),
      kocName: input.kocName?.trim() || null,
      autoFetchEnabled: input.autoFetchEnabled ?? false,
      fetchFrequency: input.autoFetchEnabled ? (input.fetchFrequency ?? "daily") : null,
      notes: input.notes?.trim() || null
    }
  });
}
