import {
  BarChart3,
  ChevronDown,
  Clock3,
  Copy,
  FileText,
  Filter,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Trash2,
  Video
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  CreateProjectInput,
  DeleteKocChannelResponse,
  DeleteProjectResponse,
  FeedbackItem,
  FetchFrequency,
  Importance,
  JobSummary,
  Polarity,
  ProjectDashboard,
  ProjectJobsResponse,
  ProjectSummary
} from "@koc-dashboard/shared";

interface ProjectsResponse {
  projects: ProjectSummary[];
}

interface CreateProjectResponse {
  project: {
    id: string;
  };
}

type WorkspaceTab = "overview" | "feedback" | "report";
type FilterPolarity = Polarity | "all";
type FilterImportance = Importance | "all";

const emptyDashboardMessage = "暂无项目数据。请先创建项目并添加 KOC 频道。";

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "待处理",
    processing: "处理中",
    done: "完成",
    failed: "失败"
  };
  return labels[status] ?? status;
}

function frequencyLabel(frequency: string | null): string {
  const labels: Record<string, string> = {
    daily: "每天",
    every_2_days: "每 2 天",
    weekly: "每周"
  };
  return frequency ? labels[frequency] : "未开启";
}

function polarityLabel(polarity: string | null): string {
  const labels: Record<string, string> = {
    positive: "正面",
    neutral: "中性",
    negative: "负面"
  };
  return polarity ? labels[polarity] : "无";
}

function importanceLabel(importance: Importance): string {
  const labels: Record<Importance, string> = {
    high: "高",
    medium: "中",
    low: "低"
  };
  return labels[importance];
}

function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<ProjectDashboard | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectContext, setNewProjectContext] = useState("");
  const [newProjectKeywords, setNewProjectKeywords] = useState("");
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [deleteProjectCandidate, setDeleteProjectCandidate] = useState<ProjectSummary | null>(null);
  const [isDeletingProject, setIsDeletingProject] = useState(false);
  const [deleteChannelCandidate, setDeleteChannelCandidate] = useState<{ id: string; channelName: string } | null>(null);
  const [isDeletingChannel, setIsDeletingChannel] = useState(false);
  const [newChannelUrl, setNewChannelUrl] = useState("");
  const [newKocName, setNewKocName] = useState("");
  const [newChannelAutoFetch, setNewChannelAutoFetch] = useState(true);
  const [newChannelFrequency, setNewChannelFrequency] = useState<FetchFrequency>("daily");
  const [isSubmittingChannel, setIsSubmittingChannel] = useState(false);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview");
  const [feedbackPolarity, setFeedbackPolarity] = useState<FilterPolarity>("all");
  const [feedbackImportance, setFeedbackImportance] = useState<FilterImportance>("all");
  const [feedbackChannel, setFeedbackChannel] = useState("all");
  const [feedbackSearch, setFeedbackSearch] = useState("");
  const [videoSearch, setVideoSearch] = useState("");
  const [expandedFeedbackId, setExpandedFeedbackId] = useState<string | null>(null);

  const loadJobs = useCallback(async (projectId: string) => {
    const jobsResponse = await fetch(`/api/projects/${projectId}/jobs`);
    if (!jobsResponse.ok) {
      setJobs([]);
      return [];
    }

    const jobsPayload = (await jobsResponse.json()) as ProjectJobsResponse;
    setJobs(jobsPayload.jobs);
    return jobsPayload.jobs;
  }, []);

  const loadDashboard = useCallback(async (options?: { projectId?: string; silent?: boolean; skipJobs?: boolean }) => {
    if (!options?.silent) {
      setIsLoading(true);
    }
    try {
      const projectsResponse = await fetch("/api/projects");
      if (!projectsResponse.ok) {
        throw new Error("项目列表加载失败。");
      }

      const projectsPayload = (await projectsResponse.json()) as ProjectsResponse;
      const loadedProjects = projectsPayload.projects;
      setProjects(loadedProjects);
      const targetProject =
        loadedProjects.find((project) => project.id === (options?.projectId ?? selectedProjectId)) ??
        loadedProjects[0];

      if (!targetProject) {
        setDashboard(null);
        setSelectedProjectId(null);
        setJobs([]);
        setErrorMessage(emptyDashboardMessage);
        return;
      }

      setSelectedProjectId(targetProject.id);

      const dashboardResponse = await fetch(`/api/projects/${targetProject.id}/dashboard`);
      if (!dashboardResponse.ok) {
        throw new Error("项目 Dashboard 加载失败。");
      }

      const dashboardPayload = (await dashboardResponse.json()) as ProjectDashboard;
      setDashboard(dashboardPayload);
      if (!options?.skipJobs) {
        await loadJobs(targetProject.id);
      }
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "加载失败。");
    } finally {
      if (!options?.silent) {
        setIsLoading(false);
      }
    }
  }, [loadJobs, selectedProjectId]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (!dashboard?.project.id) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      void (async () => {
        const latestJobs = await loadJobs(dashboard.project.id);
        if (shouldRefreshDashboard(latestJobs)) {
          await loadDashboard({ projectId: dashboard.project.id, silent: true, skipJobs: true });
        }
      })();
    }, 6_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [dashboard?.project.id, loadDashboard, loadJobs]);

  async function handleProjectSwitch(projectId: string) {
    setSelectedProjectId(projectId);
    setJobs([]);
    await loadDashboard({
      projectId
    });
  }

  async function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const productName = newProjectName.trim();
    if (!productName) {
      setActionMessage("请输入产品/游戏名称。");
      return;
    }

    setIsCreatingProject(true);
    setActionMessage(null);

    try {
      const input: CreateProjectInput = {
        productName,
        productContext: newProjectContext.trim() || undefined,
        keywords: splitKeywords(newProjectKeywords)
      };
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(input)
      });

      if (!response.ok) {
        throw new Error("创建项目失败。");
      }

      const payload = (await response.json()) as CreateProjectResponse;
      setNewProjectName("");
      setNewProjectContext("");
      setNewProjectKeywords("");
      setActionMessage("项目已创建，可以添加 KOC 频道。");
      await loadDashboard({
        projectId: payload.project.id
      });
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "创建项目失败。");
    } finally {
      setIsCreatingProject(false);
    }
  }

  async function handleDeleteProject() {
    const project = deleteProjectCandidate;
    if (!project) {
      return;
    }

    setIsDeletingProject(true);
    setActionMessage(null);

    try {
      const response = await fetch(`/api/projects/${project.id}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error("删除项目失败。");
      }

      const payload = (await response.json()) as DeleteProjectResponse;
      setDeleteProjectCandidate(null);
      setJobs([]);
      setFeedbackChannel("all");
      setFeedbackSearch("");
      setVideoSearch("");
      setExpandedFeedbackId(null);
      setDeleteChannelCandidate(null);
      setActionMessage(`项目「${project.productName}」已删除。`);

      if (payload.nextProjectId) {
        await loadDashboard({
          projectId: payload.nextProjectId
        });
        return;
      }

      setProjects([]);
      setSelectedProjectId(null);
      setDashboard(null);
      setErrorMessage(emptyDashboardMessage);
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "删除项目失败。");
    } finally {
      setIsDeletingProject(false);
    }
  }

  async function handleAddChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!dashboard) {
      return;
    }

    if (!newChannelUrl.trim()) {
      setActionMessage("请输入 KOC YouTube 频道链接。");
      return;
    }

    setIsSubmittingChannel(true);
    setActionMessage(null);

    try {
      const response = await fetch(`/api/projects/${dashboard.project.id}/channels`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          channelUrl: newChannelUrl,
          kocName: newKocName,
          autoFetchEnabled: newChannelAutoFetch,
          fetchFrequency: newChannelAutoFetch ? newChannelFrequency : null
        })
      });

      if (!response.ok) {
        throw new Error("添加频道失败。");
      }

      setNewChannelUrl("");
      setNewKocName("");
      setActionMessage("频道已添加，已创建频道解析任务。");
      await loadDashboard();
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "添加频道失败。");
    } finally {
      setIsSubmittingChannel(false);
    }
  }

  async function handleDeleteChannel() {
    const channel = deleteChannelCandidate;
    if (!channel) {
      return;
    }

    setIsDeletingChannel(true);
    setActionMessage(null);

    try {
      const response = await fetch(`/api/channels/${channel.id}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error("删除 KOC 频道失败。");
      }

      const payload = (await response.json()) as DeleteKocChannelResponse;
      setDeleteChannelCandidate(null);
      setFeedbackChannel("all");
      setExpandedFeedbackId(null);
      setActionMessage(`KOC 频道「${channel.channelName}」已删除。`);

      if (payload.deletedChannelId && dashboard?.project.id) {
        await loadDashboard({
          projectId: dashboard.project.id
        });
      }
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "删除 KOC 频道失败。");
    } finally {
      setIsDeletingChannel(false);
    }
  }

  async function handleManualFetch(channel?: { id: string; channelName: string }) {
    const targetChannels = channel ? [channel] : (dashboard?.channels ?? []);
    if (!targetChannels.length) {
      setActionMessage("暂无可抓取的 KOC 频道。");
      return;
    }

    try {
      const responses = await Promise.all(
        targetChannels.map((targetChannel) =>
          fetch(`/api/channels/${targetChannel.id}/fetch`, {
            method: "POST"
          })
        )
      );

      if (responses.some((response) => !response.ok)) {
        throw new Error("手动抓取任务创建失败。");
      }

      setActionMessage(channel ? `已为 ${channel.channelName} 创建手动抓取任务。` : `已为 ${targetChannels.length} 个 KOC 创建手动抓取任务。`);
      await loadDashboard({
        projectId: dashboard?.project.id
      });
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "手动抓取任务创建失败。");
    }
  }

  async function handleRegenerateReport() {
    if (!dashboard) {
      return;
    }

    try {
      const response = await fetch(`/api/projects/${dashboard.project.id}/report/regenerate`, {
        method: "POST"
      });

      if (!response.ok) {
        throw new Error("报告生成任务创建失败。");
      }

      setActionMessage("已创建项目报告生成任务。");
      await loadDashboard({ silent: true });
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "报告生成任务创建失败。");
    }
  }

  async function handleCopyReport() {
    const reportText = dashboard?.report?.reportText;
    if (!reportText) {
      setActionMessage("暂无可复制报告。");
      return;
    }

    await navigator.clipboard.writeText(reportText);
    setActionMessage("项目报告已复制。");
  }

  const feedback = dashboard?.feedback ?? [];
  const channels = dashboard?.channels ?? [];
  const videos = dashboard?.videos ?? [];
  const reportUpdatedAt = dashboard?.report ? formatRelativeTime(dashboard.report.generatedAt) : "暂无报告";
  const feedbackCounts = useMemo(() => countFeedback(feedback), [feedback]);
  const sortedFeedback = useMemo(() => [...feedback].sort(compareFeedback), [feedback]);
  const priorityFeedback = useMemo(
    () => sortedFeedback.filter((item) => item.polarity === "negative" || item.importance === "high").slice(0, 5),
    [sortedFeedback]
  );
  const bestPositive = useMemo(() => sortedFeedback.find((item) => item.polarity === "positive"), [sortedFeedback]);
  const pendingOrProblemJobs = useMemo(() => jobs.filter((job) => job.status !== "done").slice(0, 5), [jobs]);
  const recentJobs = pendingOrProblemJobs.length ? pendingOrProblemJobs : jobs.slice(0, 4);
  const filteredFeedback = useMemo(() => {
    const query = feedbackSearch.trim().toLowerCase();
    return sortedFeedback.filter((item) => {
      const matchesPolarity = feedbackPolarity === "all" || item.polarity === feedbackPolarity;
      const matchesImportance = feedbackImportance === "all" || item.importance === feedbackImportance;
      const matchesChannel = feedbackChannel === "all" || item.channelName === feedbackChannel;
      const matchesSearch =
        !query ||
        item.summary.toLowerCase().includes(query) ||
        item.sourceVideo.toLowerCase().includes(query) ||
        item.evidenceZh.toLowerCase().includes(query);
      return matchesPolarity && matchesImportance && matchesChannel && matchesSearch;
    });
  }, [feedbackChannel, feedbackImportance, feedbackPolarity, feedbackSearch, sortedFeedback]);
  const filteredVideos = useMemo(() => {
    const query = videoSearch.trim().toLowerCase();
    if (!query) {
      return videos;
    }
    return videos.filter((videoItem) => `${videoItem.title} ${videoItem.channelName}`.toLowerCase().includes(query));
  }, [videoSearch, videos]);
  const channelFilterOptions = useMemo(
    () => Array.from(new Set(feedback.map((item) => item.channelName))).filter(Boolean),
    [feedback]
  );

  const tabs: Array<{ id: WorkspaceTab; label: string; icon: typeof BarChart3; count?: number }> = [
    { id: "overview", label: "概览", icon: BarChart3 },
    { id: "feedback", label: "反馈明细", icon: Filter, count: feedback.length },
    { id: "report", label: "项目报告", icon: FileText, count: dashboard?.report?.version }
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">K</div>
          <div>
            <strong>KOC 反馈工作台</strong>
            <span>YouTube 项目分析</span>
          </div>
        </div>

        <div className="project-control">
          <label className="project-switcher">
            <span>当前项目</span>
            <select
              value={dashboard?.project.id ?? selectedProjectId ?? ""}
              onChange={(event) => void handleProjectSwitch(event.target.value)}
              disabled={!projects.length || isDeletingProject}
            >
              {projects.map((project) => (
                <option value={project.id} key={project.id}>
                  {project.productName}
                </option>
              ))}
            </select>
          </label>
          <button
            className="danger-button project-delete-button"
            type="button"
            disabled={!dashboard || isDeletingProject}
            onClick={() => {
              if (dashboard?.project) {
                setDeleteProjectCandidate(dashboard.project);
              }
            }}
          >
            <Trash2 size={16} />
            删除项目
          </button>
        </div>

        {deleteProjectCandidate ? (
          <div className="confirm-panel" role="alertdialog" aria-labelledby="delete-project-title">
            <strong id="delete-project-title">删除「{deleteProjectCandidate.productName}」？</strong>
            <p>会同时删除该项目下的 KOC、视频、反馈、报告和相关任务记录，操作不可恢复。</p>
            <div className="confirm-actions">
              <button
                className="ghost-button"
                type="button"
                disabled={isDeletingProject}
                onClick={() => setDeleteProjectCandidate(null)}
              >
                取消
              </button>
              <button className="danger-button" type="button" disabled={isDeletingProject} onClick={() => void handleDeleteProject()}>
                {isDeletingProject ? "删除中" : "确认删除"}
              </button>
            </div>
          </div>
        ) : null}

        <nav className="nav-list" aria-label="主导航">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                className={`nav-item ${activeTab === tab.id ? "active" : ""}`}
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon size={18} />
                <span>{tab.label}</span>
                {tab.count ? <em>{tab.id === "report" ? `v${tab.count}` : tab.count}</em> : null}
              </button>
            );
          })}
        </nav>

        <details className="sidebar-drawer">
          <summary>
            <Plus size={16} />
            新建项目
            <ChevronDown size={16} />
          </summary>
          <form className="stack-form" onSubmit={handleCreateProject}>
            <label>
              <span>产品/游戏名称</span>
              <input
                type="text"
                placeholder="例如 FragPunk"
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
              />
            </label>
            <label>
              <span>产品背景</span>
              <input
                type="text"
                placeholder="可选：版本、赛季、重点功能"
                value={newProjectContext}
                onChange={(event) => setNewProjectContext(event.target.value)}
              />
            </label>
            <label>
              <span>补充关键词</span>
              <input
                type="text"
                placeholder="可选：逗号或空格分隔"
                value={newProjectKeywords}
                onChange={(event) => setNewProjectKeywords(event.target.value)}
              />
            </label>
            <button className="primary-button" type="submit" disabled={isCreatingProject}>
              {isCreatingProject ? "创建中" : "创建项目"}
            </button>
          </form>
        </details>

        <section className="sidebar-section">
          <div className="sidebar-heading">
            <Rss size={16} />
            <strong>KOC 频道</strong>
          </div>
          {deleteChannelCandidate ? (
            <div className="confirm-panel compact" role="alertdialog" aria-labelledby="delete-channel-title">
              <strong id="delete-channel-title">删除「{deleteChannelCandidate.channelName}」？</strong>
              <p>会同时删除该频道下的视频、反馈和相关任务记录，操作不可恢复。</p>
              <div className="confirm-actions">
                <button
                  className="ghost-button"
                  type="button"
                  disabled={isDeletingChannel}
                  onClick={() => setDeleteChannelCandidate(null)}
                >
                  取消
                </button>
                <button className="danger-button" type="button" disabled={isDeletingChannel} onClick={() => void handleDeleteChannel()}>
                  {isDeletingChannel ? "删除中" : "确认删除"}
                </button>
              </div>
            </div>
          ) : null}
          <div className="side-channel-list">
            {channels.length ? (
              channels.map((channel) => (
                <div className="side-channel" key={channel.id}>
                  <div>
                    <strong>{channel.channelName}</strong>
                    <span>{frequencyLabel(channel.fetchFrequency)}</span>
                  </div>
                  <div className="channel-actions">
                    <button className="icon-button" type="button" onClick={() => void handleManualFetch(channel)} aria-label={`抓取 ${channel.channelName}`}>
                      <RefreshCw size={15} />
                    </button>
                    <button
                      className="icon-button danger-icon"
                      type="button"
                      disabled={isDeletingChannel}
                      onClick={() => setDeleteChannelCandidate(channel)}
                      aria-label={`删除 ${channel.channelName}`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-compact">暂无频道</div>
            )}
          </div>
        </section>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="project-title">
            <p className="eyebrow">项目工作台</p>
            <h1>{dashboard?.project.productName ?? (isLoading ? "加载中" : "暂无项目")}</h1>
            <span>{dashboard?.project.productContext || "当前项目下所有已分析 KOC 视频"}</span>
          </div>
          <div className="topbar-actions">
            <button className="ghost-button" type="button" onClick={() => void handleRegenerateReport()}>
              <FileText size={17} />
              重新生成报告
            </button>
            <button className="primary-button" type="button" onClick={() => void handleManualFetch()}>
              <RefreshCw size={17} />
              抓取全部 KOC
            </button>
          </div>
        </header>

        {errorMessage ? <div className="notice">{errorMessage}</div> : null}
        {actionMessage ? <div className="notice success">{actionMessage}</div> : null}

        {activeTab === "overview" ? (
          <OverviewTab
            dashboard={dashboard}
            feedbackCounts={feedbackCounts}
            filteredVideos={filteredVideos}
            priorityFeedback={priorityFeedback}
            bestPositive={bestPositive}
            recentJobs={recentJobs}
            reportUpdatedAt={reportUpdatedAt}
            videoSearch={videoSearch}
            newChannelUrl={newChannelUrl}
            newKocName={newKocName}
            newChannelAutoFetch={newChannelAutoFetch}
            newChannelFrequency={newChannelFrequency}
            isSubmittingChannel={isSubmittingChannel}
            onVideoSearchChange={setVideoSearch}
            onChannelUrlChange={setNewChannelUrl}
            onKocNameChange={setNewKocName}
            onChannelAutoFetchChange={setNewChannelAutoFetch}
            onChannelFrequencyChange={setNewChannelFrequency}
            onAddChannel={handleAddChannel}
            onRefreshJobs={() => {
              if (dashboard?.project.id) {
                void loadJobs(dashboard.project.id);
              }
            }}
          />
        ) : null}

        {activeTab === "feedback" ? (
          <FeedbackTab
            channels={channelFilterOptions}
            expandedFeedbackId={expandedFeedbackId}
            feedback={filteredFeedback}
            feedbackChannel={feedbackChannel}
            feedbackImportance={feedbackImportance}
            feedbackPolarity={feedbackPolarity}
            feedbackSearch={feedbackSearch}
            totalCount={feedback.length}
            onChannelChange={setFeedbackChannel}
            onExpandedFeedbackChange={setExpandedFeedbackId}
            onImportanceChange={setFeedbackImportance}
            onPolarityChange={setFeedbackPolarity}
            onSearchChange={setFeedbackSearch}
          />
        ) : null}

        {activeTab === "report" ? (
          <ReportTab
            dashboard={dashboard}
            feedback={sortedFeedback}
            reportUpdatedAt={reportUpdatedAt}
            onCopyReport={() => void handleCopyReport()}
            onRegenerateReport={() => void handleRegenerateReport()}
          />
        ) : null}
      </main>
    </div>
  );
}

export default App;

function OverviewTab(props: {
  dashboard: ProjectDashboard | null;
  feedbackCounts: ReturnType<typeof countFeedback>;
  filteredVideos: ProjectDashboard["videos"];
  priorityFeedback: FeedbackItem[];
  bestPositive: FeedbackItem | undefined;
  recentJobs: JobSummary[];
  reportUpdatedAt: string;
  videoSearch: string;
  newChannelUrl: string;
  newKocName: string;
  newChannelAutoFetch: boolean;
  newChannelFrequency: FetchFrequency;
  isSubmittingChannel: boolean;
  onVideoSearchChange: (value: string) => void;
  onChannelUrlChange: (value: string) => void;
  onKocNameChange: (value: string) => void;
  onChannelAutoFetchChange: (value: boolean) => void;
  onChannelFrequencyChange: (value: FetchFrequency) => void;
  onAddChannel: (event: FormEvent<HTMLFormElement>) => void;
  onRefreshJobs: () => void;
}) {
  const {
    dashboard,
    feedbackCounts,
    filteredVideos,
    priorityFeedback,
    bestPositive,
    recentJobs,
    reportUpdatedAt,
    videoSearch,
    newChannelUrl,
    newKocName,
    newChannelAutoFetch,
    newChannelFrequency,
    isSubmittingChannel,
    onVideoSearchChange,
    onChannelUrlChange,
    onKocNameChange,
    onChannelAutoFetchChange,
    onChannelFrequencyChange,
    onAddChannel,
    onRefreshJobs
  } = props;

  const stats = [
    { label: "KOC", value: dashboard ? String(dashboard.stats.kocCount) : "-", detail: `${dashboard?.stats.autoFetchEnabledCount ?? 0} 个自动抓取` },
    { label: "视频", value: dashboard ? String(dashboard.stats.analyzedVideoCount) : "-", detail: `${dashboard?.videos.length ?? 0} 条已入库` },
    { label: "高优先级", value: dashboard ? String(dashboard.stats.highImportanceCount) : "-", detail: `负面 ${dashboard?.stats.negativeRiskCount ?? 0} 条` },
    { label: "报告", value: dashboard?.stats.reportVersion ? `v${dashboard.stats.reportVersion}` : "-", detail: reportUpdatedAt }
  ];

  return (
    <div className="tab-stack">
      <section className="stats-grid" aria-label="项目指标">
        {stats.map((stat) => (
          <div className="metric" key={stat.label}>
            <span>{stat.label}</span>
            <strong>{stat.value}</strong>
            <small>{stat.detail}</small>
          </div>
        ))}
      </section>

      <section className="insight-band">
        <div className="insight-cell negative">
          <span>优先处理</span>
          <strong>{priorityFeedback[0]?.summary ?? "暂无高优先级风险"}</strong>
        </div>
        <div className="insight-cell positive">
          <span>可放大正向</span>
          <strong>{bestPositive?.summary ?? "暂无明确正向亮点"}</strong>
        </div>
        <div className="insight-cell">
          <span>反馈结构</span>
          <strong>
            正面 {feedbackCounts.positive} / 中性 {feedbackCounts.neutral} / 负面 {feedbackCounts.negative}
          </strong>
        </div>
      </section>

      <section className="panel">
        <SectionHeader eyebrow="KOC 覆盖" title="频道抓取状态" />
        <div className="channel-status-table">
          <div className="channel-status-row header">
            <span>KOC</span>
            <span>抓取状态</span>
            <span>上次抓取</span>
            <span>下次自动</span>
            <span>失败原因</span>
          </div>
          {dashboard?.channels.length ? (
            dashboard.channels.map((channel) => {
              const failureReason = channelFailureReason(channel);
              return (
                <div className="channel-status-row" key={channel.id}>
                  <span className="channel-name">{channel.channelName}</span>
                  <span className={`status ${channelStatusClass(channel)}`}>
                    <Clock3 size={14} />
                    {channelStatusLabel(channel)}
                  </span>
                  <span>{channel.lastFetchedAt ? formatRelativeTime(channel.lastFetchedAt) : "尚未抓取"}</span>
                  <span>{formatNextFetch(channel)}</span>
                  <span className={failureReason ? "failure-text" : "muted-text"}>{failureReason ?? "无"}</span>
                </div>
              );
            })
          ) : (
            <div className="empty-state">暂无频道。</div>
          )}
        </div>
      </section>

      <section className="work-grid">
        <div className="panel priority-panel">
          <SectionHeader eyebrow="重点问题" title="需要产品先看的内容" />
          <div className="priority-list">
            {priorityFeedback.length ? (
              priorityFeedback.map((item) => (
                <article className={`priority-item ${item.polarity}`} key={item.id}>
                  <span className={`tone-dot ${item.polarity}`} />
                  <div>
                    <strong>{item.summary}</strong>
                    <p>
                      {item.channelName} / {item.sourceVideo} / {item.timestamp}
                    </p>
                  </div>
                  <span className={`importance-badge ${item.importance}`}>{importanceLabel(item.importance)}</span>
                </article>
              ))
            ) : (
              <div className="empty-state">暂无需要优先处理的问题。</div>
            )}
          </div>
        </div>

        <div className="panel config-panel">
          <SectionHeader eyebrow="抓取配置" title="添加 KOC 频道" />
          <form className="stack-form" onSubmit={onAddChannel}>
            <label>
              <span>频道链接</span>
              <input
                type="url"
                placeholder="https://youtube.com/@channel"
                value={newChannelUrl}
                onChange={(event) => onChannelUrlChange(event.target.value)}
              />
            </label>
            <label>
              <span>KOC 备注</span>
              <input
                type="text"
                placeholder="可选"
                value={newKocName}
                onChange={(event) => onKocNameChange(event.target.value)}
              />
            </label>
            <div className="inline-controls">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={newChannelAutoFetch}
                  onChange={(event) => onChannelAutoFetchChange(event.target.checked)}
                />
                <span>自动抓取</span>
              </label>
              <select
                value={newChannelFrequency}
                disabled={!newChannelAutoFetch}
                onChange={(event) => onChannelFrequencyChange(event.target.value as FetchFrequency)}
              >
                <option value="daily">每天</option>
                <option value="every_2_days">每 2 天</option>
                <option value="weekly">每周</option>
              </select>
            </div>
            <button className="primary-button" type="submit" disabled={isSubmittingChannel}>
              {isSubmittingChannel ? "添加中" : "添加频道"}
            </button>
          </form>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <SectionHeader eyebrow="分析队列" title="视频状态" />
          <label className="search-box">
            <Search size={16} />
            <input
              type="search"
              placeholder="搜索视频或频道"
              value={videoSearch}
              onChange={(event) => onVideoSearchChange(event.target.value)}
            />
          </label>
        </div>
        <div className="data-table">
          <div className="data-row header">
            <span>视频标题</span>
            <span>KOC</span>
            <span>状态</span>
            <span>倾向</span>
            <span>片段</span>
            <span>高优先级</span>
            <span>失败 / 说明</span>
          </div>
          {filteredVideos.map((videoItem) => {
            const failureReason = videoFailureReason(videoItem);
            const statusNote = failureReason ?? videoItem.noFeedbackReason;
            return (
              <div className="data-row" key={videoItem.id}>
                <span className="video-title">
                  <Video size={16} />
                  {videoItem.title}
                </span>
                <span>{videoItem.channelName}</span>
                <span className={`status ${videoItem.analysisStatus}`}>
                  <Clock3 size={14} />
                  {statusLabel(videoItem.analysisStatus)}
                </span>
                <span>{polarityLabel(videoItem.primaryPolarity)}</span>
                <span>{videoItem.relatedSegmentCount}</span>
                <span>{videoItem.highImportanceCount}</span>
                <span className={failureReason ? "failure-text" : statusNote ? "note-text" : "muted-text"}>
                  {statusNote ?? "无"}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel job-panel">
        <div className="section-heading">
          <SectionHeader eyebrow="后台任务" title="需要关注的任务" />
          <button className="ghost-button" type="button" onClick={onRefreshJobs}>
            <RefreshCw size={17} />
            刷新
          </button>
        </div>
        <div className="job-list compact">
          {recentJobs.length ? (
            recentJobs.map((job) => (
              <div className="job-row" key={job.id}>
                <div className="job-main">
                  <strong>{jobTypeLabel(job.type)}</strong>
                  <span className={job.errorMessage ? "job-error" : undefined}>
                    {job.errorMessage ? `失败原因：${job.errorMessage}` : `创建于 ${formatRelativeTime(job.createdAt)}`}
                  </span>
                </div>
                <div className="job-meta">
                  <span className={`status-pill ${job.status}`}>{statusLabel(job.status)}</span>
                  <span>{formatJobTime(job)}</span>
                </div>
              </div>
            ))
          ) : (
            <div className="empty-state">暂无后台任务。</div>
          )}
        </div>
      </section>
    </div>
  );
}

function FeedbackTab(props: {
  channels: string[];
  expandedFeedbackId: string | null;
  feedback: FeedbackItem[];
  feedbackChannel: string;
  feedbackImportance: FilterImportance;
  feedbackPolarity: FilterPolarity;
  feedbackSearch: string;
  totalCount: number;
  onChannelChange: (value: string) => void;
  onExpandedFeedbackChange: (value: string | null) => void;
  onImportanceChange: (value: FilterImportance) => void;
  onPolarityChange: (value: FilterPolarity) => void;
  onSearchChange: (value: string) => void;
}) {
  const {
    channels,
    expandedFeedbackId,
    feedback,
    feedbackChannel,
    feedbackImportance,
    feedbackPolarity,
    feedbackSearch,
    totalCount,
    onChannelChange,
    onExpandedFeedbackChange,
    onImportanceChange,
    onPolarityChange,
    onSearchChange
  } = props;

  return (
    <section className="panel tall-panel">
      <div className="section-heading">
        <SectionHeader eyebrow="反馈明细" title={`${feedback.length} / ${totalCount} 条反馈`} />
        <label className="search-box">
          <Search size={16} />
          <input
            type="search"
            placeholder="搜索观点、视频或证据"
            value={feedbackSearch}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </label>
      </div>

      <div className="filter-bar">
        <SegmentedControl
          label="倾向"
          value={feedbackPolarity}
          options={[
            ["all", "全部"],
            ["negative", "负面"],
            ["neutral", "中性"],
            ["positive", "正面"]
          ]}
          onChange={(value) => onPolarityChange(value as FilterPolarity)}
        />
        <SegmentedControl
          label="优先级"
          value={feedbackImportance}
          options={[
            ["all", "全部"],
            ["high", "高"],
            ["medium", "中"],
            ["low", "低"]
          ]}
          onChange={(value) => onImportanceChange(value as FilterImportance)}
        />
        <label className="select-filter">
          <span>KOC</span>
          <select value={feedbackChannel} onChange={(event) => onChannelChange(event.target.value)}>
            <option value="all">全部</option>
            {channels.map((channel) => (
              <option value={channel} key={channel}>
                {channel}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="feedback-list">
        {feedback.length ? (
          feedback.map((item) => {
            const isExpanded = expandedFeedbackId === item.id;
            return (
              <article className={`feedback-row ${item.polarity}`} key={item.id}>
                <button
                  className="feedback-row-main"
                  type="button"
                  onClick={() => onExpandedFeedbackChange(isExpanded ? null : item.id)}
                >
                  <span className={`tone-dot ${item.polarity}`} />
                  <div>
                    <div className="feedback-row-title">
                      <strong>{item.summary}</strong>
                      <span className={`importance-badge ${item.importance}`}>{importanceLabel(item.importance)}</span>
                    </div>
                    <p>
                      {polarityLabel(item.polarity)} / {item.channelName} / {item.sourceVideo} / {item.timestamp}
                    </p>
                  </div>
                  <ChevronDown className={isExpanded ? "rotate" : ""} size={18} />
                </button>
                {isExpanded ? (
                  <div className="feedback-detail">
                    <div>
                      <span>中文翻译</span>
                      <p>{item.evidenceZh}</p>
                    </div>
                    <div>
                      <span>英文原文</span>
                      <p>{item.evidence}</p>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })
        ) : (
          <div className="empty-state">当前筛选下暂无反馈。</div>
        )}
      </div>
    </section>
  );
}

function ReportTab(props: {
  dashboard: ProjectDashboard | null;
  feedback: FeedbackItem[];
  reportUpdatedAt: string;
  onCopyReport: () => void;
  onRegenerateReport: () => void;
}) {
  const { dashboard, feedback, reportUpdatedAt, onCopyReport, onRegenerateReport } = props;
  const evidenceList = feedback.slice(0, 8);

  return (
    <section className="report-layout">
      <div className="panel report-panel">
        <div className="section-heading">
          <SectionHeader eyebrow="项目报告" title="可复制短版" />
          <div className="report-actions">
            <button className="ghost-button" type="button" onClick={onRegenerateReport}>
              <RefreshCw size={17} />
              重新生成
            </button>
            <button className="primary-button" type="button" onClick={onCopyReport}>
              <Copy size={17} />
              复制
            </button>
          </div>
        </div>
        <div className="report-meta">
          <span>{dashboard?.stats.reportVersion ? `版本 v${dashboard.stats.reportVersion}` : "暂无版本"}</span>
          <span>{reportUpdatedAt}</span>
        </div>
        <pre className="report-preview">{dashboard?.report?.reportText ?? "暂无项目级报告。"}</pre>
      </div>

      <aside className="panel evidence-panel">
        <SectionHeader eyebrow="证据详情" title="原文与翻译" />
        <div className="evidence-list">
          {evidenceList.length ? (
            evidenceList.map((item) => (
              <article className="evidence-card" key={item.id}>
                <div>
                  <span className={`status-pill ${item.polarity}`}>{polarityLabel(item.polarity)}</span>
                  <span className={`importance-badge ${item.importance}`}>{importanceLabel(item.importance)}</span>
                </div>
                <strong>{item.summary}</strong>
                <p>{item.evidenceZh}</p>
                <small>
                  {item.channelName} / {item.sourceVideo} / {item.timestamp}
                </small>
              </article>
            ))
          ) : (
            <div className="empty-state">暂无证据。</div>
          )}
        </div>
      </aside>
    </section>
  );
}

function SectionHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="section-title">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
    </div>
  );
}

function SegmentedControl(props: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="segmented-field">
      <span>{props.label}</span>
      <div className="segmented-control">
        {props.options.map(([value, label]) => (
          <button
            className={props.value === value ? "active" : ""}
            key={value}
            type="button"
            onClick={() => props.onChange(value)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function countFeedback(feedback: FeedbackItem[]) {
  return feedback.reduce(
    (acc, item) => {
      acc[item.polarity] += 1;
      return acc;
    },
    {
      positive: 0,
      neutral: 0,
      negative: 0
    } satisfies Record<Polarity, number>
  );
}

function compareFeedback(left: FeedbackItem, right: FeedbackItem): number {
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
    importanceRank[right.importance] - importanceRank[left.importance] ||
    polarityRank[right.polarity] - polarityRank[left.polarity]
  );
}

function formatRelativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60_000));

  if (diffMinutes < 1) {
    return "刚刚";
  }

  if (diffMinutes < 60) {
    return `${diffMinutes} 分钟前`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} 小时前`;
  }

  return `${Math.floor(diffHours / 24)} 天前`;
}

function jobTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    resolve_channel: "解析频道",
    sync_channel: "抓取视频",
    analyze_video: "分析视频",
    generate_project_report: "生成报告"
  };
  return labels[type] ?? type;
}

function channelStatusLabel(channel: ProjectDashboard["channels"][number]): string {
  if (channel.metadataStatus !== "done") {
    return `频道${statusLabel(channel.metadataStatus)}`;
  }

  if (channel.lastFetchStatus) {
    return statusLabel(channel.lastFetchStatus);
  }

  return channel.autoFetchEnabled ? "等待自动" : "未抓取";
}

function channelStatusClass(channel: ProjectDashboard["channels"][number]): string {
  if (channel.metadataStatus === "failed" || channel.lastFetchStatus === "failed") {
    return "failed";
  }

  if (channel.metadataStatus === "processing" || channel.lastFetchStatus === "processing") {
    return "processing";
  }

  if (channel.lastFetchStatus === "done") {
    return "done";
  }

  return "pending";
}

function channelFailureReason(channel: ProjectDashboard["channels"][number]): string | null {
  if (channel.lastFetchError) {
    return channel.lastFetchError;
  }

  if (channel.metadataError) {
    return channel.metadataError;
  }

  return null;
}

function formatNextFetch(channel: ProjectDashboard["channels"][number]): string {
  if (!channel.autoFetchEnabled) {
    return "未开启";
  }

  if (!channel.nextFetchAt) {
    return "待调度";
  }

  return formatFutureRelativeTime(channel.nextFetchAt);
}

function formatFutureRelativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) {
    return formatRelativeTime(value);
  }

  const diffMinutes = Math.ceil(diffMs / 60_000);
  if (diffMinutes < 60) {
    return `${diffMinutes} 分钟后`;
  }

  const diffHours = Math.ceil(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} 小时后`;
  }

  return `${Math.ceil(diffHours / 24)} 天后`;
}

function videoFailureReason(video: ProjectDashboard["videos"][number]): string | null {
  return video.analysisFailureReason ?? video.transcriptFailureReason ?? null;
}

function splitKeywords(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\s,，;；、]+/)
        .map((keyword) => keyword.trim())
        .filter(Boolean)
    )
  );
}

function formatJobTime(job: JobSummary): string {
  if (job.finishedAt) {
    return `${formatRelativeTime(job.finishedAt)}完成`;
  }

  if (job.startedAt) {
    return `${formatRelativeTime(job.startedAt)}开始`;
  }

  return `${formatRelativeTime(job.createdAt)}创建`;
}

function shouldRefreshDashboard(jobs: JobSummary[]): boolean {
  return jobs.some((job) => {
    if (job.status === "pending" || job.status === "processing") {
      return true;
    }

    if (!job.finishedAt) {
      return false;
    }

    return Date.now() - new Date(job.finishedAt).getTime() < 30_000;
  });
}
