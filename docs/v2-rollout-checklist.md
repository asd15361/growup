# V2 执行清单（我负责推进）

最后更新：2026-02-20

## 0. 规则（必须执行）

- 每次代码变更后必须做线上验收，不验收不算完成。
- 每次打包必须记录版本、时间、文件路径、校验结果。
- 每次 Sealos 发布必须走“变更/Redeploy”，不能只点 Restart。
- 每次阶段完成必须同步到 `docs/worklog-2026-02-20.md`。

## 1. 当前阶段状态（Phase A：记忆层解耦）

- [x] 后端 identity/state 优先读写 `memories`，旧逻辑自动回退。
- [x] 新增 `GET /api/memories` 接口。
- [x] `.env.example` 增加 `POCKETBASE_MEMORIES_COLLECTION`。
- [x] 新增迁移脚本 `npm run migrate:memory`。
- [ ] 在 PocketBase 创建 `memories` collection（线上）。
- [ ] Sealos 发布后验收 `GET /api/memories` 返回正常。
- [ ] 对 1 个老账号执行迁移脚本并记录结果。

## 2. 本阶段发布步骤（固定流程）

1. 本地代码检查
- `node --check server/index.js`
- `node --check scripts/migrate-legacy-memory.js`

2. 推送后端代码并触发 Sealos 变更发布
- 在 Sealos 对 `growup-api-3c44t6` 点 `变更`（不是 `Restart`）。

3. 线上验收（必须全部通过）
- `npm run smoke:sealos`
- `GET /api/health` 中包含 `pocketbase.memoriesCollection`
- `GET /api/memories`（带 token）返回 `200`

4. 迁移验收（抽样账号）
- 设置环境变量：
  - `API_BASE_URL`
  - `MIGRATE_EMAIL`
  - `MIGRATE_PASSWORD`
- 执行：`npm run migrate:memory`
- 预期日志包含：
  - `identity migrated` 或 `identity not found`
  - `state migrated` 或 `state not found`
  - `done. memories=...`

5. 文档记录（必须）
- 更新 `docs/worklog-2026-02-20.md`：发布时间、验收结果、迁移结果。

## 3. 下一阶段预告（Phase B）

- [ ] 引入异步任务队列（抽取任务从 `/api/chat` 主链路剥离）
- [ ] 增加 memory extractor service（结构化记忆，不先上图库）
- [ ] 增加失败重试与死信队列监控

## 4. 快速口令（你只要说一句）

- 你说：`继续下一步`  
我就按清单自动执行，不需要你记任何命令。
