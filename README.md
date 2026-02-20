# 知己

知己是一款中文 AI 伙伴聊天 App，核心目标是“长期陪伴 + 自动复盘 + 持久记忆”。

## 当前功能

- 邮箱注册/登录（PocketBase）
- 首次登录身份设定（用户称呼 + 伙伴名，默认“贾维斯”）
- 图文聊天（文本模型/视觉模型自动路由）
- 聊天记录、图片、身份设定、成长状态云端持久化
- 日/周/月/年复盘自动生成（基于聊天记录）

## 技术结构

- 移动端：Expo + React Native（`App.tsx`）
- API：Node.js + Express（`server/index.js`）
- 存储：PocketBase（`users` + `chat_messages` + `memories`）
- 模型：
  - 文本：默认 `glm-4.7-flash`（如配置 `DEEPSEEK_API_KEY` 则纯文本走 DeepSeek）
  - 视觉：`glm-4.6v-flash`

## 关键目录

```text
App.tsx                 # 主界面/登录/身份设定/聊天/复盘
src/lib/api.ts          # 前端 API 封装
src/lib/memoryEngine.ts # 记忆抽取与检索
src/lib/recapEngine.ts  # 复盘构建逻辑
server/index.js         # 后端 API
api/[...all].js         # Vercel 入口（可选）
docs/                   # 部署与运行文档
```

## 本地启动

1. 安装依赖

```bash
npm install
```

2. 创建环境变量文件

```bash
copy .env.example .env.local
```

3. 填写 `.env.local`（最少）

- `ZHIPU_API_KEY`
- `POCKETBASE_URL_NEW`
- `POCKETBASE_USERS_COLLECTION=users`
- `POCKETBASE_CHAT_COLLECTION=chat_messages`
- `POCKETBASE_MEMORIES_COLLECTION=memories`
- `EXPO_PUBLIC_API_BASE_URL`（建议填 Sealos API 域名）

4. 启动后端

```bash
npm run server
```

5. 启动 App

```bash
npm run start
```

## 线上建议

中国网络下建议 API 部署到 Sealos，不建议继续依赖 `vercel.app` 作为主链路。

- Sealos API 部署：`docs/sealos-api-deploy.md`
- 当前运行状态：`docs/sealos-runtime-status.md`
- V2 执行清单：`docs/v2-rollout-checklist.md`

## 线上烟测

```bash
npm run smoke:sealos
```

## 旧数据迁移（identity/state -> memories）

```bash
$env:API_BASE_URL="https://growup-api-3c44t6.cloud.sealos.io"
$env:MIGRATE_EMAIL="you@example.com"
$env:MIGRATE_PASSWORD="your-password"
npm run migrate:memory
```

## Android 打包

```bash
npm run build:apk
```

- 主产物：`app-release-v<版本>.apk`（例如 `app-release-v1.18.0.apk`）
- 兼容产物：`app-release.apk`

## 安全说明

- 不要把真实 API Key、PocketBase 管理员密码、加密密钥提交到仓库。
- 若密钥曾外泄，请立即在对应平台重置。
