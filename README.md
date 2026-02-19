# GrowUp

GrowUp 是一个 AI 成长陪跑 App，已支持：
- 邮箱注册/登录（PocketBase）
- 首次登录身份设定（用户名 + AI 伙伴名，默认「贾维斯」）
- 图文聊天（文本模型 + 视觉模型自动切换）
- 聊天与图片云端存储（PocketBase）
- 日记与本地记忆压缩

## 模型
- 文本：`glm-4.7-flash`
- 视觉：`glm-4.6v-flash`

## 快速启动
1. 安装依赖
```bash
npm install
```

2. 创建环境文件
```bash
copy .env.example .env.local
```

3. 填写 `.env.local`
- `ZHIPU_API_KEY`
- `POCKETBASE_URL_NEW`（指向你的新实例）
- `POCKETBASE_USERS_COLLECTION`（默认 `users`）
- `POCKETBASE_CHAT_COLLECTION`（默认 `chat_messages`）
- `EXPO_PUBLIC_API_BASE_URL`（真机调试用局域网地址）

4. 启动后端
```bash
npm run server
```

5. 启动 App
```bash
npm run start
```

## PocketBase 集合要求
### `users`
- Auth 集合（可邮箱密码登录）
- 建议字段：`name`（文本）

### `chat_messages`
- `user`（Relation -> users，必填）
- `role`（Text，值建议：`user` / `assistant`）
- `text`（Text）
- `model`（Text，可空）
- `image`（File，可空）

建议访问规则：
- list/view/create/update/delete: `@request.auth.id != "" && user.id = @request.auth.id`

## 当前后端接口
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/history`
- `GET /api/identity`
- `POST /api/identity`
- `POST /api/chat`
- `GET /api/health`

## 项目结构
```text
App.tsx                  # 高级 UI + 登录 + 首次身份设定 + 图文聊天
server/index.js          # 智谱 + PocketBase 后端
src/lib/api.ts           # 前端 API 封装
src/lib/session.ts       # 登录会话存储
src/lib/identity.ts      # 用户/伙伴命名设定存储
src/lib/memoryEngine.ts  # 本地记忆抽取与压缩
```
