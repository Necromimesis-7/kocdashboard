import type { Importance, Polarity, SpeakerType } from "@koc-dashboard/shared";

export interface TranscriptAnalysisInputSegment {
  id: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  text: string;
  sourceLanguage: string | null;
  textZh?: string | null;
}

export interface AnalyzedTranscriptSegment extends TranscriptAnalysisInputSegment {
  textZh: string;
  isProductRelated: boolean;
  relevanceReason: string | null;
}

export interface ExtractedFeedback {
  polarity: Polarity;
  importance: Importance;
  summary: string;
  suggestion: string | null;
  speakerType: SpeakerType;
  confidence: number;
  evidenceSegmentIds: string[];
}

export interface AnalyzeTranscriptInput {
  productName: string;
  keywords: string[];
  segments: TranscriptAnalysisInputSegment[];
}

export interface AnalyzeTranscriptResult {
  segments: AnalyzedTranscriptSegment[];
  feedback: ExtractedFeedback[];
}

export interface ProjectReportFeedbackInput {
  polarity: Polarity;
  importance: Importance;
  summary: string;
  suggestion: string | null;
  confidence: number;
  videoTitle: string;
  channelName: string;
  evidenceText: string;
  evidenceZh: string;
  timestamp: string;
}

export interface BuildProjectReportInput {
  productName: string;
  generatedAt: Date;
  kocCount: number;
  analyzedVideoCount: number;
  feedback: ProjectReportFeedbackInput[];
}

interface DerivedFeedbackSignal {
  polarity: Polarity;
  importance: Importance;
  topic: string;
  viewpoint: string;
  scenario: string;
  suggestion: string;
  evidenceSummary: string;
  confidence: number;
  reportable: boolean;
}

interface ReportSource {
  channelName: string;
  videoTitle: string;
  timestamp: string;
}

interface ReportInsight extends DerivedFeedbackSignal {
  key: string;
  sources: ReportSource[];
}

export const REPORT_SECTION_TITLES = [
  "核心判断",
  "优先处理",
  "可放大正向",
  "继续观察",
  "证据索引"
] as const;

export function buildAnalysisSystemPrompt(): string {
  return [
    "你是面向游戏产品团队的 KOC 视频反馈分析助手。",
    "只基于证据片段输出结论，不编造没有证据支持的内容。",
    "每条反馈只能归为 positive、neutral、negative 之一。",
    "每条证据必须保留原始片段，并提供中文翻译。",
    "如果判断不确定，降低 confidence，并避免写成确定结论。"
  ].join("\n");
}

export async function analyzeTranscript(input: AnalyzeTranscriptInput): Promise<AnalyzeTranscriptResult> {
  if (isAiProviderEnabled() && getAiApiKey()) {
    const openAiResult = await tryAnalyzeWithOpenAi(input).catch((error: unknown) => {
      console.warn(`AI 分析请求失败，回退到规则引擎：${error instanceof Error ? error.message : String(error)}`);
      return null;
    });

    if (openAiResult) {
      return openAiResult;
    }
  }

  return analyzeTranscriptWithRules(input);
}

export function analyzeTranscriptWithRules(input: AnalyzeTranscriptInput): AnalyzeTranscriptResult {
  const normalizedKeywords = normalizeKeywords([input.productName, ...input.keywords]);
  const analyzedSegments = input.segments.map((segment) => {
    const signal = scoreSegment(segment.text, normalizedKeywords);
    const textZh = segment.textZh?.trim() || fallbackTranslateToChinese(segment.text);

    return {
      ...segment,
      textZh,
      isProductRelated: signal.isRelated,
      relevanceReason: signal.isRelated ? signal.reason : null
    };
  });

  const feedback = analyzedSegments
    .filter((segment) => segment.isProductRelated)
    .map((segment) => buildFeedbackFromSegment(segment, scoreSegment(segment.text, normalizedKeywords)))
    .filter((item): item is ExtractedFeedback => Boolean(item))
    .slice(0, 12);

  return {
    segments: analyzedSegments,
    feedback
  };
}

export function buildProjectReport(input: BuildProjectReportInput): string {
  const insights = buildReportInsights(input.feedback);
  const positive = insights.filter((item) => item.polarity === "positive");
  const neutral = insights.filter((item) => item.polarity === "neutral");
  const negative = insights.filter((item) => item.polarity === "negative");
  const highRiskCount = negative.filter((item) => item.importance === "high").length;
  const filteredCount = Math.max(input.feedback.length - insights.length, 0);
  const generatedDate = input.generatedAt.toISOString().slice(0, 10);

  return [
    "【KOC 项目反馈摘要】",
    `产品/游戏：${input.productName}｜样本：${input.kocCount} 个 KOC / ${input.analyzedVideoCount} 条视频｜日期：${generatedDate}`,
    filteredCount ? `说明：已过滤 ${filteredCount} 条重复、泛口播或低信息量信号；结论仅代表当前已分析样本。` : "说明：已合并重复观点；结论仅代表当前已分析样本。",
    "",
    "一、核心判断",
    ...buildOverallConclusion(insights, highRiskCount),
    "",
    "二、优先处理",
    ...formatActionItems(negative, "当前样本中暂无明确负面风险。"),
    "",
    "三、可放大正向",
    ...formatPositiveItems(positive),
    "",
    "四、继续观察",
    ...formatWatchItems(neutral),
    "",
    "五、证据索引",
    ...formatEvidenceDetails(insights)
  ].join("\n");
}

function normalizeKeywords(keywords: string[]): string[] {
  return Array.from(
    new Set(
      keywords
        .flatMap((keyword) => keyword.toLowerCase().split(/[\s,，/]+/))
        .map((keyword) => keyword.trim())
        .filter((keyword) => keyword.length >= 3)
    )
  );
}

interface SegmentSignal {
  isRelated: boolean;
  polarity: Polarity;
  importance: Importance;
  confidence: number;
  reason: string;
  issueLabel: string;
}

function scoreSegment(text: string, keywords: string[]): SegmentSignal {
  const lower = text.toLowerCase();
  const derivedSignal = deriveFeedbackSignal(text);
  const matchedKeyword = keywords.find((keyword) => lower.includes(keyword) && !GENERIC_SIGNAL_KEYWORDS.has(keyword));
  const negativeSignal = findSignal(lower, NEGATIVE_SIGNALS);
  const positiveSignal = findSignal(lower, POSITIVE_SIGNALS);
  const neutralSignal = findSignal(lower, NEUTRAL_SIGNALS);
  const contextSignal = findSignal(lower, GAME_CONTEXT_SIGNALS);
  const hasGameContext = Boolean(matchedKeyword || contextSignal || lower.includes("fragpunk"));
  const lexicalSignal = negativeSignal ?? positiveSignal ?? neutralSignal;
  const isWeakLexicalSignal = lexicalSignal ? WEAK_LEXICAL_SIGNAL_LABELS.has(lexicalSignal.label) : false;
  const isRelated = derivedSignal ? derivedSignal.reportable : Boolean(hasGameContext && lexicalSignal && !isWeakLexicalSignal);
  const polarity = derivedSignal?.polarity ?? (negativeSignal ? "negative" : positiveSignal ? "positive" : "neutral");
  const importance: Importance = derivedSignal?.importance ?? negativeSignal?.importance ?? (matchedKeyword ? "medium" : "low");
  const issueLabel = derivedSignal?.topic ?? negativeSignal?.label ?? positiveSignal?.label ?? neutralSignal?.label ?? contextSignal?.label ?? "产品体验";
  const signalReason = [matchedKeyword ? `命中关键词「${matchedKeyword}」` : null, negativeSignal ?? positiveSignal ?? neutralSignal ? `命中体验信号「${issueLabel}」` : null]
    .filter(Boolean)
    .join("，");

  return {
    isRelated,
    polarity,
    importance,
    confidence: isRelated ? (derivedSignal?.confidence ?? (negativeSignal || positiveSignal ? 0.68 : 0.56)) : 0.28,
    reason: signalReason || "未命中明确产品相关信号",
    issueLabel
  };
}

function buildFeedbackFromSegment(
  segment: AnalyzedTranscriptSegment,
  signal: SegmentSignal
): ExtractedFeedback | null {
  if (!signal.isRelated) {
    return null;
  }

  const summaryPrefix =
    signal.polarity === "negative"
      ? `KOC 提到${signal.issueLabel}相关风险`
      : signal.polarity === "positive"
        ? `KOC 对${signal.issueLabel}给出正面反馈`
        : `KOC 对${signal.issueLabel}进行中性说明`;
  const derivedSignal = deriveFeedbackSignal(segment.text);

  return {
    polarity: derivedSignal?.polarity ?? signal.polarity,
    importance: derivedSignal?.importance ?? signal.importance,
    summary: derivedSignal?.viewpoint ?? `${summaryPrefix}。`,
    suggestion: derivedSignal?.suggestion ?? buildSuggestion(signal),
    speakerType: "koc_self",
    confidence: derivedSignal?.confidence ?? signal.confidence,
    evidenceSegmentIds: [segment.id]
  };
}

function buildSuggestion(signal: SegmentSignal): string | null {
  if (signal.polarity === "positive") {
    return "保留当前被认可的体验点，并在后续版本继续观察是否稳定复现。";
  }

  if (signal.polarity === "neutral") {
    return "结合更多 KOC 和玩家反馈判断该观察是否需要产品动作。";
  }

  if (["性能 / 卡顿", "稳定性"].includes(signal.issueLabel)) {
    return "优先排查相关场景的性能、加载和稳定性链路。";
  }

  if (["商业化压力", "养成压力"].includes(signal.issueLabel)) {
    return "复核新老玩家的资源获取节奏和付费压力感知。";
  }

  return "将该负面信号纳入产品问题池，并结合更多样本确认影响范围。";
}

function fallbackTranslateToChinese(text: string): string {
  if (containsCjk(text)) {
    return text;
  }

  const derivedSignal = deriveFeedbackSignal(text);
  if (derivedSignal) {
    return derivedSignal.evidenceSummary;
  }

  const lowered = text.trim().toLowerCase();
  const fragments: string[] = [];

  if (findSignal(lowered, NEGATIVE_SIGNALS)) {
    fragments.push("该片段提到负面体验或风险");
  } else if (findSignal(lowered, POSITIVE_SIGNALS)) {
    fragments.push("该片段提到正面体验");
  } else if (findSignal(lowered, NEUTRAL_SIGNALS)) {
    fragments.push("该片段是中性描述或机制说明");
  } else {
    fragments.push("该片段需要人工或 AI 进一步翻译");
  }

  return fragments.join("，");
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

interface LexiconSignal {
  terms: string[];
  label: string;
  importance?: Importance;
}

function findSignal(text: string, signals: LexiconSignal[]): LexiconSignal | null {
  return signals.find((signal) => signal.terms.some((term) => text.includes(term))) ?? null;
}

const NEGATIVE_SIGNALS: LexiconSignal[] = [
  {
    label: "性能 / 卡顿",
    importance: "high",
    terms: ["lag", "stutter", "fps", "frame drop", "drops", "卡顿", "掉帧", "帧率"]
  },
  {
    label: "稳定性",
    importance: "high",
    terms: ["bug", "crash", "freeze", "broken", "glitch", "bug", "崩溃", "闪退", "冻结"]
  },
  {
    label: "加载体验",
    importance: "medium",
    terms: ["loading", "load time", "slow", "加载", "慢"]
  },
  {
    label: "商业化压力",
    importance: "medium",
    terms: ["paywall", "expensive", "pricey", "too much money", "付费墙", "太贵", "氪"]
  },
  {
    label: "养成压力",
    importance: "medium",
    terms: ["grind", "too much farming", "repetitive", "肝", "刷太多", "重复"]
  },
  {
    label: "负面体验",
    importance: "medium",
    terms: ["bad", "worse", "annoying", "frustrating", "problem", "issue", "糟糕", "烦", "问题"]
  }
];

const POSITIVE_SIGNALS: LexiconSignal[] = [
  {
    label: "操作手感",
    terms: ["responsive", "smooth", "fluid", "snappy", "跟手", "流畅", "顺滑"]
  },
  {
    label: "内容体验",
    terms: ["fun", "great", "good", "love", "enjoy", "solid", "polished", "好玩", "喜欢", "不错"]
  },
  {
    label: "奖励体验",
    terms: ["rewarding", "generous", "worth it", "奖励不错", "福利"]
  }
];

const NEUTRAL_SIGNALS: LexiconSignal[] = [
  {
    label: "活动 / 奖励",
    terms: ["reward", "event", "banner", "活动", "奖励", "卡池"]
  },
  {
    label: "角色 / Build",
    terms: ["character", "build", "kit", "skill", "角色", "技能", "配装"]
  },
  {
    label: "抽卡 / 养成",
    terms: ["gacha", "pull", "farming", "progression", "抽卡", "养成"]
  },
  {
    label: "版本内容",
    terms: ["update", "patch", "mode", "quest", "版本", "模式", "任务"]
  }
];

const GAME_CONTEXT_SIGNALS: LexiconSignal[] = [
  {
    label: "关卡 / 波次",
    terms: ["wave", "boss", "stage", "level", "toy frontline", "关卡", "波次", "boss"]
  },
  {
    label: "Build / 技能树",
    terms: ["skill tree", "ability", "build", "upgrade", "turret", "技能树", "技能", "升级", "炮台"]
  },
  {
    label: "资源 / 卡牌",
    terms: ["free lunch", "crystal bank", "card", "cards", "money", "resource", "资源", "卡牌"]
  },
  {
    label: "奖励 / 开箱",
    terms: ["can opening", "cans", "dupe", "knife", "ak", "skin", "purple", "blue", "green", "weapon", "开箱", "皮肤", "武器", "重复"]
  }
];

const GENERIC_SIGNAL_KEYWORDS = new Set(["bug", "lag", "crash", "fps", "freeze", "loading", "stutter", "paywall", "gacha", "grind"]);
const WEAK_LEXICAL_SIGNAL_LABELS = new Set(["内容体验", "加载体验", "负面体验"]);

function deriveFeedbackSignal(text: string): DerivedFeedbackSignal | null {
  const lower = text.toLowerCase();
  const compact = compactEvidenceText(text);

  if (containsAny(lower, ["youtube's slower speed", "watch the last", "watch this video", "subscribe"]) && !containsAny(lower, ["bugged", "money glitch", "take too long"])) {
    return null;
  }

  if (containsAny(lower, ["infinite money glitch", "money glitch"]) || (containsAny(lower, ["free lunch", "crystal bank"]) && lower.includes("get more"))) {
    return {
      polarity: "negative",
      importance: "high",
      topic: "资源 / 经济漏洞",
      viewpoint: "KOC 认为资源卡牌与水晶银行的组合可能形成近似无限经济收益。",
      scenario: "关卡波次推进中的卡牌激活、资源积累和升级节奏。",
      suggestion: "复核免费午餐卡、水晶银行等资源增益的叠加上限、触发顺序和单局收益曲线。",
      evidenceSummary: "KOC 将该流程形容为类似“无限金钱漏洞”，并描述通过资源卡牌和水晶银行继续获得更多资源。",
      confidence: 0.86,
      reportable: true
    };
  }

  if (containsAny(lower, ["why is it so bugged", "so bugged", "bugged?"]) || (lower.includes("opens everything") && containsAny(lower, ["bug", "bugged"]))) {
    return {
      polarity: "negative",
      importance: "high",
      topic: "奖励开启异常",
      viewpoint: "KOC 在奖励/开箱流程中遇到一次性打开全部或异常开启行为，并明确质疑该流程存在异常。",
      scenario: "奖励开启、开箱或批量打开道具时的交互反馈。",
      suggestion: "检查奖励开启状态机、批量打开逻辑和客户端表现，确认是否存在误触发或状态同步问题。",
      evidenceSummary: "KOC 提到“它直接打开了所有东西”，随后质疑为什么会出现这种异常。",
      confidence: 0.84,
      reportable: true
    };
  }

  if (lower.includes("take too long") && !lower.includes("youtube")) {
    return {
      polarity: "negative",
      importance: "medium",
      topic: "奖励开启节奏",
      viewpoint: "KOC 认为逐个开启奖励或等待结果的过程耗时偏长。",
      scenario: "开箱、奖励揭示或逐个结算道具的流程。",
      suggestion: "评估奖励揭示动画、批量开启入口和跳过机制，减少重复操作等待。",
      evidenceSummary: "KOC 评价如果一个一个开会花太久，说明当前奖励揭示节奏可能偏慢。",
      confidence: 0.72,
      reportable: true
    };
  }

  if (containsAny(lower, ["got scammed", "zero dupes", "bad", "worst one", "bad start"]) && containsAny(lower, ["dupe", "knife", "purple", "blue", "green", "cans", "opening", "luck", "ak"])) {
    return {
      polarity: "negative",
      importance: "medium",
      topic: "抽取 / 开箱挫败",
      viewpoint: "KOC 在抽取或开箱过程中多次表达结果不理想、重复或低价值奖励带来的挫败感。",
      scenario: "皮肤、武器或箱子奖励的随机抽取过程。",
      suggestion: "关注重复奖励、保底展示和稀有奖励预期管理，避免长时间开箱只得到低价值反馈。",
      evidenceSummary: "KOC 多次表达结果很差、重复奖励不理想、感觉被坑等不满，并持续期待目标奖励。",
      confidence: 0.74,
      reportable: true
    };
  }

  if (containsAny(lower, ["got the ak", "this is good", "please be the knife"]) && containsAny(lower, ["ak", "knife", "weapon", "skin", "cans", "opening"])) {
    return {
      polarity: "positive",
      importance: "low",
      topic: "目标奖励认可",
      viewpoint: "KOC 对抽到目标武器或高价值奖励结果表示认可。",
      scenario: "皮肤、武器或箱子奖励的结果揭示。",
      suggestion: "保留目标奖励带来的即时正反馈，同时继续观察重复奖励和非目标结果的挫败感。",
      evidenceSummary: "KOC 在抽到目标武器或期待刀类奖励时表示这是好结果。",
      confidence: 0.66,
      reportable: true
    };
  }

  const hasModeTutorialSignal =
    containsAny(lower, ["toy frontline", "skill tree", "turrets", "wave number", "boss round"]) ||
    (containsAny(lower, ["stage two", "upgrades"]) && containsAny(lower, ["wave", "boss", "turret", "skill tree", "toy frontline"]));
  const hasSkinReviewContext = containsAny(lower, [
    "skin",
    "skins",
    "bundle",
    "weapon",
    "gun",
    "cans",
    "opening",
    "knife",
    "ak",
    "fever",
    "electronic wonderland",
    "inspect",
    "kill effect",
    "final kill",
    "hammer"
  ]);

  if (hasModeTutorialSignal && !hasSkinReviewContext) {
    return {
      polarity: "neutral",
      importance: "low",
      topic: "关卡教学复杂度",
      viewpoint: "KOC 主要在讲解关卡波次、技能树、升级和摆放策略，说明该模式存在一定学习和执行门槛。",
      scenario: "关卡攻略、波次准备、技能树选择和炮台/升级配置。",
      suggestion: "评估新手引导、推荐构筑、关键波次提示是否足够清晰，降低玩家只依赖外部教程的成本。",
      evidenceSummary: "KOC 用较长篇幅说明阶段、波次、技能树和升级配置，内容偏机制教学。",
      confidence: 0.62,
      reportable: true
    };
  }

  if (compact.length < 30 || containsAny(lower, ["listen up chat", "our good friend", "welcome to", "check that video out"])) {
    return null;
  }

  return null;
}

function buildReportInsights(feedback: ProjectReportFeedbackInput[]): ReportInsight[] {
  const grouped = new Map<string, ReportInsight>();

  for (const item of feedback) {
    const derivedSignal = deriveFeedbackSignal(item.evidenceText) ?? deriveFeedbackSignal(item.summary);
    const compatibleDerivedSignal = derivedSignal?.polarity === item.polarity ? derivedSignal : null;
    const fallbackSignal = compatibleDerivedSignal ?? buildFallbackReportSignal(item);

    if (!fallbackSignal?.reportable) {
      continue;
    }

    const reportSignal: DerivedFeedbackSignal = {
      ...fallbackSignal,
      polarity: item.polarity,
      importance: item.importance
    };

    const key = normalizeInsightKey(reportSignal.topic, reportSignal.viewpoint);
    const existing = grouped.get(key);
    const source = {
      channelName: item.channelName,
      videoTitle: item.videoTitle,
      timestamp: item.timestamp
    };

    if (existing) {
      if (!existing.sources.some((existingSource) => sameSource(existingSource, source))) {
        existing.sources.push(source);
      }
      existing.confidence = Math.max(existing.confidence, reportSignal.confidence, item.confidence);
      existing.importance = higherImportance(existing.importance, reportSignal.importance);
      continue;
    }

    grouped.set(key, {
      ...reportSignal,
      confidence: Math.max(reportSignal.confidence, item.confidence),
      key,
      sources: [source]
    });
  }

  return Array.from(grouped.values()).sort(compareInsights);
}

function buildFallbackReportSignal(item: ProjectReportFeedbackInput): DerivedFeedbackSignal | null {
  const viewpoint = toChineseSummary(item.summary);
  const evidenceSummary = toChineseEvidence(item.evidenceZh);

  if (!viewpoint || isGenericSummary(viewpoint)) {
    return null;
  }

  return {
    polarity: item.polarity,
    importance: item.importance,
    topic: inferTopicFromSummary(viewpoint),
    viewpoint,
    scenario: "需要结合详情原文进一步确认具体发生场景。",
    suggestion: item.suggestion ?? "结合更多样本和原始片段确认该反馈是否需要进入产品问题池。",
    evidenceSummary,
    confidence: Math.min(item.confidence, 0.62),
    reportable: item.confidence >= 0.6
  };
}

function buildOverallConclusion(insights: ReportInsight[], highRiskCount: number): string[] {
  if (!insights.length) {
    return [
      "- 当前样本中暂无可直接给产品使用的明确反馈。",
      "- 建议补充更具体的产品关键词，或继续扩大 KOC 样本后再判断。"
    ];
  }

  const positiveCount = insights.filter((item) => item.polarity === "positive").length;
  const neutralCount = insights.filter((item) => item.polarity === "neutral").length;
  const negativeCount = insights.filter((item) => item.polarity === "negative").length;
  const topRisk = insights.find((item) => item.polarity === "negative");
  const topPositive = insights.find((item) => item.polarity === "positive");
  const conclusion =
    negativeCount > positiveCount
      ? `- 当前反馈偏风险导向：负面/风险 ${negativeCount} 条、正面 ${positiveCount} 条、中性 ${neutralCount} 条，高风险 ${highRiskCount} 条。`
      : positiveCount > negativeCount
        ? `- 当前反馈偏正向：正面 ${positiveCount} 条、负面/风险 ${negativeCount} 条、中性 ${neutralCount} 条，高风险 ${highRiskCount} 条。`
        : `- 当前反馈正负并列：正面 ${positiveCount} 条、负面/风险 ${negativeCount} 条、中性 ${neutralCount} 条，高风险 ${highRiskCount} 条。`;

  return [
    conclusion,
    topRisk ? `- 最需要处理：${topRisk.viewpoint}` : "- 当前未发现明确负面风险。",
    topPositive ? `- 最值得放大：${topPositive.viewpoint}` : "- 当前暂无明确正向亮点。"
  ];
}

function formatActionItems(insights: ReportInsight[], emptyText: string): string[] {
  if (!insights.length) {
    return [`- ${emptyText}`];
  }

  return insights.slice(0, 4).flatMap((item, index) => [
    `${index + 1}. [${importanceToZh(item.importance)}] ${item.viewpoint}`,
    `   为什么重要：${formatImpact(item)}`,
    `   建议动作：${item.suggestion}`,
    `   证据：${formatPrimarySource(item)}；${item.evidenceSummary}`
  ]);
}

function formatPositiveItems(insights: ReportInsight[]): string[] {
  if (!insights.length) {
    return ["- 暂无明确正向亮点。"];
  }

  return insights
    .slice(0, 3)
    .flatMap((item, index) => [
      `${index + 1}. ${item.viewpoint}`,
      `   可复用方向：${item.suggestion}`,
      `   证据：${formatPrimarySource(item)}；${item.evidenceSummary}`
    ]);
}

function formatWatchItems(insights: ReportInsight[]): string[] {
  if (!insights.length) {
    return ["- 暂无需要单独观察的中性信号。"];
  }

  return insights.slice(0, 2).flatMap((item, index) => [
    `${index + 1}. ${item.viewpoint}`,
    `   观察原因：${formatImpact(item)}`,
    `   下一步：${item.suggestion}`,
    `   证据：${formatPrimarySource(item)}；${item.evidenceSummary}`
  ]);
}

function formatEvidenceDetails(insights: ReportInsight[]): string[] {
  if (!insights.length) {
    return ["- 暂无证据。"];
  }

  return insights.slice(0, 6).map((item, index) => {
    const source = item.sources[0];
    return `${index + 1}. [${polarityToZh(item.polarity)} / ${importanceToZh(item.importance)}] ${source.channelName} / ${source.timestamp} / 《${source.videoTitle}》`;
  });
}

function toChineseSummary(summary: string): string {
  const withoutQuotedEvidence = summary.replace(/：「[^」]*」/g, "。").replace(/:"[^"]*"/g, "。");
  return toChineseOnlyText(withoutQuotedEvidence);
}

function toChineseEvidence(evidenceZh: string): string {
  const cleaned = toChineseOnlyText(evidenceZh);
  return cleaned || "该证据已在详情中保留原文，中文翻译待补充。";
}

function toChineseOnlyText(value: string): string {
  return localizeCommonEnglishTerms(value)
    .replace(/(该片段(?:提到|是|需要)[^：。]*)(?:：.*)?$/g, "$1。")
    .replace(/“([^”]+)”“\1”/g, "“$1”")
    .replace(/“([^”]+)”“\1”/g, "“$1”")
    .replace(/\s+([，。！？；、])/g, "$1")
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
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
    .join("");
}

function localizeCommonEnglishTerms(value: string): string {
  return value
    .replace(/getting scammed|got scammed|scammed/gi, "被坑")
    .replace(/bugged/gi, "异常")
    .replace(/\bbugs?\b/gi, "问题")
    .replace(/take too long/gi, "耗时过长")
    .replace(/infinite money glitch|money glitch/gi, "无限金钱漏洞")
    .replace(/\bPistol\b/gi, "手枪")
    .replace(/\bAK\b/g, "目标步枪")
    .replace(/\bknife\b/gi, "刀类奖励")
    .replace(/\bdupes?\b/gi, "重复奖励")
    .replace(/\bpurple\b/gi, "高稀有度结果")
    .replace(/\bblue\b/gi, "低稀有度结果")
    .replace(/\bgreen\b/gi, "低稀有度结果")
    .replace(/\bloot light coins?\b/gi, "活动代币");
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function compactEvidenceText(text: string): string {
  return text
    .replace(/>>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeInsightKey(topic: string, viewpoint: string): string {
  return `${topic}:${viewpoint}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N}:]+/gu, "");
}

function sameSource(left: ReportSource, right: ReportSource): boolean {
  return left.channelName === right.channelName && left.videoTitle === right.videoTitle && left.timestamp === right.timestamp;
}

function higherImportance(left: Importance, right: Importance): Importance {
  const rank: Record<Importance, number> = {
    high: 3,
    medium: 2,
    low: 1
  };

  return rank[right] > rank[left] ? right : left;
}

function compareInsights(left: ReportInsight, right: ReportInsight): number {
  const polarityRank: Record<Polarity, number> = {
    negative: 3,
    positive: 2,
    neutral: 1
  };
  const importanceRank: Record<Importance, number> = {
    high: 3,
    medium: 2,
    low: 1
  };

  return (
    polarityRank[right.polarity] - polarityRank[left.polarity] ||
    importanceRank[right.importance] - importanceRank[left.importance] ||
    right.sources.length - left.sources.length ||
    right.confidence - left.confidence
  );
}

function isGenericSummary(summary: string): boolean {
  return [
    "KOC 对内容体验给出正面反馈。",
    "KOC 对角色 / Build进行中性说明。",
    "KOC 对活动 / 奖励进行中性说明。",
    "KOC 对版本内容进行中性说明。",
    "KOC 提到负面体验相关风险。",
    "KOC 提到加载体验相关风险。",
    "KOC 提到稳定性相关风险。",
    "KOC 提到性能 / 卡顿相关风险。"
  ].includes(summary);
}

function inferTopicFromSummary(summary: string): string {
  if (summary.includes("卡顿") || summary.includes("性能")) {
    return "性能 / 卡顿";
  }

  if (summary.includes("加载")) {
    return "加载体验";
  }

  if (summary.includes("稳定") || summary.includes("bug")) {
    return "稳定性";
  }

  if (summary.includes("奖励") || summary.includes("抽")) {
    return "奖励 / 抽取";
  }

  if (summary.includes("角色") || summary.includes("Build")) {
    return "角色 / Build";
  }

  return "产品体验";
}

function formatSources(sources: ReportSource[]): string {
  return sources
    .slice(0, 3)
    .map((source) => `${source.channelName}《${source.videoTitle}》${source.timestamp}`)
    .join("；");
}

function formatPrimarySource(item: ReportInsight): string {
  return formatSources(item.sources.slice(0, 1));
}

function formatImpact(item: ReportInsight): string {
  if (item.scenario && !item.scenario.includes("需要结合详情原文")) {
    return item.scenario;
  }

  if (item.topic === "产品体验") {
    if (item.polarity === "negative") {
      return "可能影响皮肤价值感、动效期待或实际使用意愿，建议先确认是否为多人共识。";
    }

    if (item.polarity === "positive") {
      return "说明当前内容存在可复用的外观、音效或操作反馈亮点。";
    }

    return "该观察适合作为后续样本对照，暂不直接转为产品问题。";
  }

  if (item.polarity === "negative") {
    return `可能影响${item.topic}相关体验，建议优先确认影响范围。`;
  }

  if (item.polarity === "positive") {
    return `说明${item.topic}存在可复用的正向体验点。`;
  }

  return `该观察与${item.topic}相关，当前更适合作为后续样本对照。`;
}

function polarityToZh(value: string): string {
  return value
    .replace("positive", "正面")
    .replace("neutral", "中性")
    .replace("negative", "负面");
}

function importanceToZh(value: Importance): string {
  if (value === "high") {
    return "高优先级";
  }

  if (value === "medium") {
    return "中优先级";
  }

  return "低优先级";
}

async function tryAnalyzeWithOpenAi(input: AnalyzeTranscriptInput): Promise<AnalyzeTranscriptResult | null> {
  const apiKey = getAiApiKey();
  if (!apiKey) {
    return null;
  }

  const model = getAiTextModel();
  const baseUrl = getAiBaseUrl();
  const apiStyle = getAiApiStyle();
  const prompt = buildOpenAiAnalysisPrompt(input);
  const response =
    apiStyle === "chat_completions"
      ? await requestChatCompletions({ apiKey, baseUrl, model, prompt })
      : await requestResponses({ apiKey, baseUrl, model, prompt });

  if (!response.ok) {
    console.warn(`AI 分析失败，回退到规则引擎：${response.status} ${await response.text()}`);
    return null;
  }

  const outputText = await extractAiOutputText(response, apiStyle);

  if (!outputText) {
    return null;
  }

  try {
    return normalizeOpenAiResult(JSON.parse(stripJsonFence(outputText)) as unknown, input);
  } catch (error) {
    console.warn(`AI 分析结果解析失败，回退到规则引擎：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function isAiProviderEnabled(): boolean {
  return ["openai", "openai-compatible", "company", "leihuo"].includes(process.env.AI_PROVIDER ?? "mock");
}

function getAiApiKey(): string | null {
  return process.env.AI_API_KEY || process.env.LEIHUO_API_KEY || process.env.OPENAI_API_KEY || null;
}

function getAiTextModel(): string {
  return process.env.AI_TEXT_MODEL || process.env.LEIHUO_TEXT_MODEL || process.env.OPENAI_TEXT_MODEL || "gpt-5";
}

function getAiBaseUrl(): string {
  const defaultBaseUrl = process.env.AI_PROVIDER === "leihuo" ? "https://ai.leihuo.netease.com/v1" : "https://api.openai.com/v1";
  return (process.env.AI_BASE_URL || process.env.LEIHUO_BASE_URL || process.env.OPENAI_BASE_URL || defaultBaseUrl).replace(/\/+$/, "");
}

function getAiApiStyle(): "responses" | "chat_completions" {
  const defaultStyle = process.env.AI_PROVIDER === "leihuo" ? "chat_completions" : "responses";
  const style = (process.env.AI_API_STYLE || process.env.LEIHUO_API_STYLE || process.env.OPENAI_API_STYLE || defaultStyle).toLowerCase();
  return style === "chat" || style === "chat_completions" ? "chat_completions" : "responses";
}

async function requestResponses(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
}): Promise<Response> {
  return fetch(`${input.baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: input.model,
      instructions: buildAnalysisSystemPrompt(),
      input: input.prompt
    })
  });
}

async function requestChatCompletions(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
}): Promise<Response> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: [
      {
        role: "system",
        content: buildAnalysisSystemPrompt()
      },
      {
        role: "user",
        content: input.prompt
      }
    ]
  };

  if (shouldUseChatJsonMode()) {
    body.response_format = {
      type: "json_object"
    };
  }

  return fetch(`${input.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function shouldUseChatJsonMode(): boolean {
  const value = process.env.AI_CHAT_JSON_MODE || process.env.LEIHUO_CHAT_JSON_MODE || process.env.OPENAI_CHAT_JSON_MODE || "true";
  return !["0", "false", "off", "none"].includes(value.toLowerCase());
}

async function extractAiOutputText(response: Response, apiStyle: "responses" | "chat_completions"): Promise<string | undefined> {
  if (apiStyle === "chat_completions") {
    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ text?: string }>;
        };
      }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    return Array.isArray(content) ? content.map((item) => item.text).filter(Boolean).join("\n") : content;
  }

  const payload = (await response.json()) as {
    output_text?: string;
    output?: Array<{
      content?: Array<{
        text?: string;
      }>;
    }>;
  };
  return payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).map((item) => item.text).filter(Boolean).join("\n");
}

function buildOpenAiAnalysisPrompt(input: AnalyzeTranscriptInput): string {
  return JSON.stringify({
    task: "请分析 YouTube KOC 视频字幕片段，输出 JSON。必须保留每个片段原文，提供中文翻译，并提炼 positive/neutral/negative 反馈。只输出与指定产品或关键词明确相关的内容；跳过寒暄、订阅引导、普通口头语和无法判断产品含义的片段。feedback.summary 必须是具体中文观点，写清问题/称赞点/观察点，不要写“KOC 对内容体验给出反馈”这类模板句；suggestion 必须是中文、可执行、面向产品团队。英文原文只保留在 segment.text。",
    productName: input.productName,
    keywords: input.keywords,
    outputSchema: {
      segments: [
        {
          id: "segment id",
          textZh: "中文翻译",
          isProductRelated: true,
          relevanceReason: "原因"
        }
      ],
      feedback: [
        {
          polarity: "positive | neutral | negative",
          importance: "high | medium | low",
          summary: "中文摘要",
          suggestion: "中文建议或 null",
          speakerType: "koc_self | audience_or_community | unclear",
          confidence: 0.8,
          evidenceSegmentIds: ["segment id"]
        }
      ]
    },
    segments: input.segments.slice(0, 80)
  });
}

function normalizeOpenAiResult(raw: unknown, input: AnalyzeTranscriptInput): AnalyzeTranscriptResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("OpenAI JSON 不是对象。");
  }

  const object = raw as {
    segments?: unknown;
    feedback?: unknown;
  };
  const segmentUpdates = Array.isArray(object.segments) ? object.segments : [];
  const segmentUpdateById = new Map<string, Partial<AnalyzedTranscriptSegment>>();

  for (const update of segmentUpdates) {
    if (!update || typeof update !== "object") {
      continue;
    }

    const item = update as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : null;
    if (!id) {
      continue;
    }

    segmentUpdateById.set(id, {
      textZh: typeof item.textZh === "string" ? item.textZh : undefined,
      isProductRelated: item.isProductRelated === true,
      relevanceReason: typeof item.relevanceReason === "string" ? item.relevanceReason : null
    });
  }

  const fallback = analyzeTranscriptWithRules(input);
  const segments = fallback.segments.map((segment) => {
    const update = segmentUpdateById.get(segment.id);
    return {
      ...segment,
      textZh: update?.textZh?.trim() || segment.textZh,
      isProductRelated: update?.isProductRelated ?? segment.isProductRelated,
      relevanceReason: update?.relevanceReason ?? segment.relevanceReason
    };
  });

  const feedback = Array.isArray(object.feedback)
    ? object.feedback
        .map(normalizeOpenAiFeedback)
        .filter((item): item is ExtractedFeedback => Boolean(item))
        .slice(0, 12)
    : fallback.feedback;

  return {
    segments,
    feedback: feedback.length ? feedback : fallback.feedback
  };
}

function normalizeOpenAiFeedback(raw: unknown): ExtractedFeedback | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const item = raw as Record<string, unknown>;
  const polarity = item.polarity;
  const importance = item.importance;
  const evidenceSegmentIds = Array.isArray(item.evidenceSegmentIds)
    ? item.evidenceSegmentIds.filter((id): id is string => typeof id === "string")
    : [];

  if (!isPolarity(polarity) || !isImportance(importance) || !evidenceSegmentIds.length || typeof item.summary !== "string") {
    return null;
  }

  return {
    polarity,
    importance,
    summary: item.summary,
    suggestion: typeof item.suggestion === "string" ? item.suggestion : null,
    speakerType: isSpeakerType(item.speakerType) ? item.speakerType : "unclear",
    confidence: typeof item.confidence === "number" ? item.confidence : 0.7,
    evidenceSegmentIds
  };
}

function stripJsonFence(text: string): string {
  return text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
}

function isPolarity(value: unknown): value is Polarity {
  return value === "positive" || value === "neutral" || value === "negative";
}

function isImportance(value: unknown): value is Importance {
  return value === "high" || value === "medium" || value === "low";
}

function isSpeakerType(value: unknown): value is SpeakerType {
  return value === "koc_self" || value === "audience_or_community" || value === "unclear";
}
