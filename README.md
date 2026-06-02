# Model Square · 模型广场

一个独立的「模型广场」展示页 + 管理后台。前后端单进程，零构建，丢服务器跑 `node server.js` 即可。

## 特性

- 公开模型广场页（用户免登录浏览，按渠道分组展示）
- 管理后台（密码登录）：渠道与模型的增删改查
- SQLite 单文件存储，首次启动自动注入示例数据
- 暗色玻璃拟态 UI，TailwindCSS CDN + Alpine.js，零构建依赖

## 目录结构

```
模型广场/
├── server.js          # Express 服务器 + REST API
├── package.json
├── data/square.db     # SQLite 数据库（自动生成）
└── public/
    ├── index.html     # 公开广场页
    ├── login.html     # 管理员登录
    └── admin.html     # 管理后台
```

## 启动

```bash
# 1. 安装依赖
npm install

# 2. 启动（默认端口 3210，默认密码 admin123）
node server.js

# 3. 自定义环境变量
PORT=8000 ADMIN_PASSWORD='your-strong-password' node server.js
```

环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3210` | 监听端口 |
| `ADMIN_PASSWORD` | `admin123` | 管理员密码（**生产务必修改**） |
| `SESSION_SECRET` | 随机生成 | Session 签名密钥（重启会失效，建议固定） |
| `DATA_DIR` | `./data` | 数据库存放目录 |

## 页面入口

- `GET /` — 公开模型广场
- `GET /login` — 管理员登录
- `GET /admin` — 管理后台（需登录）

## API

### 公开
- `GET /api/public/channels` — 返回所有渠道及其下启用的模型

### 管理（需 cookie session）
- `POST /api/admin/login` — body: `{ password }`
- `POST /api/admin/logout`
- `GET /api/admin/me`
- `GET|POST /api/admin/channels`
- `PUT|DELETE /api/admin/channels/:id`
- `GET|POST /api/admin/models`
- `PUT|DELETE /api/admin/models/:id`

## 部署到服务器

最简单的 systemd 方案：

```ini
# /etc/systemd/system/model-square.service
[Unit]
Description=Model Square
After=network.target

[Service]
WorkingDirectory=/opt/model-square
ExecStart=/usr/bin/node server.js
Environment=PORT=3210
Environment=ADMIN_PASSWORD=YOUR_STRONG_PASSWORD
Environment=SESSION_SECRET=YOUR_FIXED_SECRET
Restart=always
User=root

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now model-square
```

或 nginx 反代到 443：

```nginx
server {
  listen 443 ssl http2;
  server_name models.example.com;
  # ssl_certificate ...;
  location / {
    proxy_pass http://127.0.0.1:3210;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

## 数据模型

```
channels
  id, name, description, icon, color, sort_order, created_at, updated_at

models
  id, channel_id (FK→channels), name, display_name, description,
  tags (JSON array), context_length, price_input, price_output,
  enabled, sort_order, created_at, updated_at
```

价格单位约定：USD per 1M tokens。
