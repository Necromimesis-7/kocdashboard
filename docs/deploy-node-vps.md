# 云服务器部署说明

本项目按参考项目的部署方式处理：一个常驻 Node 服务同时托管前端、API 和后台 worker。

## 运行形态

- 前端：先构建到 `apps/web/dist`，再由 API 服务托管静态文件。
- API：Fastify 服务，监听平台提供的 `PORT` 或本地 `API_PORT`。
- Worker：随生产入口一起启动，负责抓取 YouTube、分析视频、生成报告。
- 数据：SQLite + 字幕/音频缓存，统一放到 `DATA_ROOT`。
- 访问保护：设置 `APP_PASSWORD` 后启用浏览器 Basic Auth。

## 服务器准备

Ubuntu 示例：

```bash
sudo apt update
sudo apt install -y nodejs npm python3-pip ffmpeg sqlite3 git
python3 -m pip install --user --upgrade yt-dlp
```

建议使用 Node 20+。如果系统源里的 Node 版本过低，用 nvm 或 NodeSource 安装新版 Node。

## 部署步骤

```bash
git clone <你的仓库地址> kocdashboard
cd kocdashboard
npm ci
npm run build
```

创建生产环境变量：

```bash
cp .env.example .env
```

至少填写：

```bash
DATA_ROOT=/var/lib/kocdashboard
APP_PASSWORD=设置一个访问密码
AI_PROVIDER=leihuo
LEIHUO_API_KEY=你的公司网关 key
LEIHUO_TEXT_MODEL=gpt-5.4-mini
YT_DLP_PATH=yt-dlp
YT_DLP_COOKIES_PATH=/var/lib/kocdashboard/youtube-cookies.txt
YT_DLP_JS_RUNTIME=node
```

初始化数据库：

```bash
sudo mkdir -p /var/lib/kocdashboard
sudo chown -R "$USER":"$USER" /var/lib/kocdashboard
npm run db:deploy
```

启动：

```bash
PORT=4176 npm start
```

验证：

```bash
curl http://127.0.0.1:4176/api/health
```

## systemd 常驻

创建 `/etc/systemd/system/kocdashboard.service`：

```ini
[Unit]
Description=KOC Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/kocdashboard
Environment=NODE_ENV=production
Environment=PORT=4176
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable kocdashboard
sudo systemctl start kocdashboard
sudo systemctl status kocdashboard
```

## 公开访问

可选方案：

- 有公网 IP：用 nginx 反代到 `127.0.0.1:4176`。
- 没有公网 IP 或不想配域名：用 `cloudflared tunnel --url http://127.0.0.1:4176` 临时分享。

nginx 示例：

```nginx
server {
  listen 80;
  server_name your-domain.com;

  location / {
    proxy_pass http://127.0.0.1:4176;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## 注意事项

- `DATA_ROOT` 必须放在服务器持久目录，不能放临时目录。
- 如果 YouTube 在服务器上提示 `Sign in to confirm you’re not a bot`，需要用专门的 YouTube 小号导出 cookies，并上传到 `YT_DLP_COOKIES_PATH` 指向的位置，例如 `/var/lib/kocdashboard/youtube-cookies.txt`。cookies 文件是敏感凭据，只放服务器，不提交到 Git。
- 当前架构适合 MVP 和分享会 demo。多人重度使用后再迁移 Postgres 和独立 worker。
- 如果公司模型网关只允许内网访问，云服务器可能无法调用网关，系统会回退到本地规则分析。
