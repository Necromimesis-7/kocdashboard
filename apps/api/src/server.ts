import "./env";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_KEYWORDS,
  type CreateKocChannelInput,
  type CreateProjectInput,
  type DeleteKocChannelResponse,
  type DeleteProjectResponse,
  type JobSummary
} from "@koc-dashboard/shared";
import { createKocChannel, createProject, prisma } from "./database";
import {
  buildDashboardResponse,
  mapChannelSummary,
  mapFeedbackItem,
  mapProjectSummary,
  mapVideoSummary
} from "./mappers";

export const server = Fastify({
  logger: true
});

await server.register(cors, {
  origin: true
});

server.addHook("onRequest", async (request, reply) => {
  if (!isAuthEnabled() || request.url === "/api/health") {
    return;
  }

  const password = readBasicAuthPassword(request.headers.authorization);
  if (password && constantTimeEquals(password, getAppPassword())) {
    return;
  }

  return reply
    .header("WWW-Authenticate", 'Basic realm="KOC Dashboard", charset="UTF-8"')
    .code(401)
    .send({
      error: "需要访问密码。"
    });
});

server.get("/api/health", async () => {
  return {
    status: "ok",
    service: "koc-dashboard-api",
    timestamp: new Date().toISOString()
  };
});

server.get("/api/default-keywords", async () => {
  return {
    keywords: DEFAULT_KEYWORDS
  };
});

server.get("/api/projects", async () => {
  const projects = await prisma.project.findMany({
    orderBy: {
      updatedAt: "desc"
    },
    include: {
      _count: {
        select: {
          channels: true,
          videos: true
        }
      }
    }
  });

  return {
    projects: projects.map(mapProjectSummary)
  };
});

server.post<{ Body: CreateProjectInput }>("/api/projects", async (request, reply) => {
  const productName = request.body.productName?.trim();

  if (!productName) {
    return reply.code(400).send({
      error: "产品/游戏名称不能为空。"
    });
  }

  const project = await createProject(request.body);
  return reply.code(201).send({
    project
  });
});

server.delete<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request, reply) => {
  const project = await prisma.project.findUnique({
    where: {
      id: request.params.projectId
    },
    select: {
      id: true,
      channels: {
        select: {
          id: true
        }
      },
      videos: {
        select: {
          id: true
        }
      }
    }
  });

  if (!project) {
    return reply.code(404).send({
      error: "项目不存在。"
    });
  }

  const nextProject = await prisma.project.findFirst({
    where: {
      id: {
        not: project.id
      }
    },
    orderBy: {
      updatedAt: "desc"
    },
    select: {
      id: true
    }
  });
  const payloadNeedles = [
    project.id,
    ...project.channels.map((channel) => channel.id),
    ...project.videos.map((video) => video.id)
  ];

  await prisma.$transaction(async (tx) => {
    await tx.job.deleteMany({
      where: {
        status: {
          not: "processing"
        },
        OR: payloadNeedles.map((needle) => ({
          payloadJson: {
            contains: needle
          }
        }))
      }
    });

    await tx.project.delete({
      where: {
        id: project.id
      }
    });
  });

  return {
    deletedProjectId: project.id,
    nextProjectId: nextProject?.id ?? null
  } satisfies DeleteProjectResponse;
});

server.get<{ Params: { projectId: string } }>("/api/projects/:projectId/dashboard", async (request, reply) => {
  const project = await prisma.project.findUnique({
    where: {
      id: request.params.projectId
    },
    include: {
      _count: {
        select: {
          channels: true,
          videos: true
        }
      }
    }
  });

  if (!project) {
    return reply.code(404).send({
      error: "项目不存在。"
    });
  }

  const [keywords, channels, videos, feedback, report] = await Promise.all([
    prisma.projectKeyword.findMany({
      where: {
        projectId: project.id
      },
      orderBy: {
        createdAt: "asc"
      }
    }),
    prisma.kocChannel.findMany({
      where: {
        projectId: project.id
      },
      orderBy: {
        createdAt: "asc"
      }
    }),
    prisma.video.findMany({
      where: {
        projectId: project.id
      },
      orderBy: {
        publishedAt: "desc"
      },
      include: {
        feedbackItems: true,
        transcriptSegments: true
      }
    }),
    prisma.feedbackItem.findMany({
      where: {
        projectId: project.id
      },
      orderBy: {
        createdAt: "asc"
      },
      include: {
        video: true,
        evidence: {
          include: {
            transcriptSegment: true
          }
        }
      }
    }),
    prisma.productReport.findFirst({
      where: {
        projectId: project.id
      },
      orderBy: {
        generatedAt: "desc"
      }
    })
  ]);

  return buildDashboardResponse({
    project,
    keywords: keywords.map((keyword) => keyword.keyword),
    channels: channels.map(mapChannelSummary),
    videos: videos.map(mapVideoSummary),
    feedback: feedback.map(mapFeedbackItem),
    report
  });
});

server.get<{ Params: { projectId: string } }>("/api/projects/:projectId/jobs", async (request, reply) => {
  const project = await prisma.project.findUnique({
    where: {
      id: request.params.projectId
    },
    select: {
      id: true
    }
  });

  if (!project) {
    return reply.code(404).send({
      error: "项目不存在。"
    });
  }

  const [channels, videos] = await Promise.all([
    prisma.kocChannel.findMany({
      where: {
        projectId: project.id
      },
      select: {
        id: true
      }
    }),
    prisma.video.findMany({
      where: {
        projectId: project.id
      },
      select: {
        id: true
      }
    })
  ]);
  const payloadNeedles = [project.id, ...channels.map((channel) => channel.id), ...videos.map((video) => video.id)];

  const jobs = payloadNeedles.length
    ? await prisma.job.findMany({
        where: {
          OR: payloadNeedles.map((needle) => ({
            payloadJson: {
              contains: needle
            }
          }))
        },
        orderBy: {
          createdAt: "desc"
        },
        take: 12
      })
    : [];

  return {
    jobs: jobs.map(
      (job): JobSummary => ({
        id: job.id,
        type: job.type,
        status: job.status,
        errorMessage: job.errorMessage,
        createdAt: job.createdAt.toISOString(),
        startedAt: job.startedAt?.toISOString() ?? null,
        finishedAt: job.finishedAt?.toISOString() ?? null
      })
    )
  };
});

server.post<{ Body: CreateKocChannelInput; Params: { projectId: string } }>(
  "/api/projects/:projectId/channels",
  async (request, reply) => {
    const project = await prisma.project.findUnique({
      where: {
        id: request.params.projectId
      }
    });

    if (!project) {
      return reply.code(404).send({
        error: "项目不存在。"
      });
    }

    if (!request.body.channelUrl?.trim()) {
      return reply.code(400).send({
        error: "KOC YouTube 频道链接不能为空。"
      });
    }

    const channel = await createKocChannel(request.params.projectId, request.body);
    const job = await prisma.job.create({
      data: {
        type: "resolve_channel",
        payloadJson: JSON.stringify({
          channelId: channel.id
        })
      }
    });

    return reply.code(201).send({
      channel,
      job
    });
  }
);

server.post<{ Params: { channelId: string } }>("/api/channels/:channelId/fetch", async (request, reply) => {
  const channel = await prisma.kocChannel.findUnique({
    where: {
      id: request.params.channelId
    }
  });

  if (!channel) {
    return reply.code(404).send({
      error: "KOC 频道不存在。"
    });
  }

  const job = await prisma.job.create({
    data: {
      type: "sync_channel",
      payloadJson: JSON.stringify({
        channelId: channel.id,
        triggerType: "manual"
      })
    }
  });

  return reply.code(202).send({
    job
  });
});

server.delete<{ Params: { channelId: string } }>("/api/channels/:channelId", async (request, reply) => {
  const channel = await prisma.kocChannel.findUnique({
    where: {
      id: request.params.channelId
    },
    select: {
      id: true,
      projectId: true,
      videos: {
        select: {
          id: true
        }
      }
    }
  });

  if (!channel) {
    return reply.code(404).send({
      error: "KOC 频道不存在。"
    });
  }

  const payloadNeedles = [channel.id, ...channel.videos.map((video) => video.id)];

  await prisma.$transaction(async (tx) => {
    await tx.job.deleteMany({
      where: {
        status: {
          not: "processing"
        },
        OR: payloadNeedles.map((needle) => ({
          payloadJson: {
            contains: needle
          }
        }))
      }
    });

    await tx.kocChannel.delete({
      where: {
        id: channel.id
      }
    });
  });

  return {
    deletedChannelId: channel.id
  } satisfies DeleteKocChannelResponse;
});

server.post<{ Params: { projectId: string } }>("/api/projects/:projectId/report/regenerate", async (request, reply) => {
  const project = await prisma.project.findUnique({
    where: {
      id: request.params.projectId
    }
  });

  if (!project) {
    return reply.code(404).send({
      error: "项目不存在。"
    });
  }

  const job = await prisma.job.create({
    data: {
      type: "generate_project_report",
      payloadJson: JSON.stringify({
        projectId: project.id
      })
    }
  });

  return reply.code(202).send({
    job
  });
});

registerStaticFrontend();

export async function startApiServer(): Promise<void> {
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4100);
  const host = process.env.API_HOST ?? process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");

  await server.listen({ port, host });
}

function registerStaticFrontend(): void {
  const webDistDir = process.env.WEB_DIST_DIR
    ? path.resolve(process.env.WEB_DIST_DIR)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");

  server.get("/*", async (request, reply) => {
    if (request.url.startsWith("/api")) {
      return reply.code(404).send({
        error: "接口不存在。"
      });
    }

    const requestPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
    const candidatePath = path.resolve(webDistDir, relativePath);
    const indexPath = path.join(webDistDir, "index.html");
    const filePath = candidatePath.startsWith(webDistDir) ? candidatePath : indexPath;
    const staticFile = await existingFilePath(filePath) ?? await existingFilePath(indexPath);

    if (!staticFile) {
      return reply.code(404).send({
        error: "前端构建产物不存在，请先运行 npm run build。"
      });
    }

    return reply.type(contentTypeFor(staticFile)).send(createReadStream(staticFile));
  });
}

async function existingFilePath(filePath: string): Promise<string | null> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile() ? filePath : null;
  } catch {
    return null;
  }
}

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp"
  };

  return contentTypes[extension] ?? "application/octet-stream";
}

function isAuthEnabled(): boolean {
  return Boolean(getAppPassword());
}

function getAppPassword(): string {
  return String(process.env.APP_PASSWORD || process.env.ACCESS_PASSWORD || "").trim();
}

function readBasicAuthPassword(headerValue: string | undefined): string | null {
  if (!headerValue?.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = Buffer.from(headerValue.slice("Basic ".length), "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    return separatorIndex === -1 ? null : decoded.slice(separatorIndex + 1);
  } catch {
    return null;
  }
}

function constantTimeEquals(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

function isMainModule(): boolean {
  return process.argv[1] ? import.meta.url === new URL(process.argv[1], "file:").href : false;
}

if (isMainModule()) {
  try {
    await startApiServer();
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
}
