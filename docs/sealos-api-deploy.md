# 知己 API（Sealos）部署说明

最后更新：2026-02-19

## 目标

把当前 API 从 Vercel 迁移到 Sealos，避免中国网络访问 `vercel.app` 不稳定导致注册/登录超时。

后端代码入口：`server/index.js`  
容器构建文件：`Dockerfile.sealos-api`

## 一、在 Sealos 新建 API 应用

1. 打开 Sealos 控制台，进入应用管理（App Launchpad）。
2. 点击新建应用，选择从 Git 仓库构建（Build from Git）。
3. 仓库填写：`https://github.com/asd15361/growup.git`
4. 分支：`master`
5. Dockerfile 路径：`Dockerfile.sealos-api`
6. 监听端口：`8787`
7. 打开公网访问，并记录生成的公网域名（例如：`https://zhiji-api-xxxx.cloud.sealos.io`）。

## 二、Sealos 环境变量（必须）

在 Sealos 应用环境变量中配置以下键值：

- `PORT=8787`
- `POCKETBASE_URL_NEW=https://pocketbase-tocxusnx.cloud.sealos.io`
- `POCKETBASE_USERS_COLLECTION=users`
- `POCKETBASE_CHAT_COLLECTION=chat_messages`
- `DEEPSEEK_API_KEY=<你的 DeepSeek key>`
- `DEEPSEEK_TEXT_MODEL=deepseek-chat`
- `DEEPSEEK_BASE_URL=https://api.deepseek.com`
- `ZHIPU_API_KEY=<你的智谱 key>`
- `ZHIPU_TEXT_MODEL=glm-4.7-flash`
- `ZHIPU_VISION_MODEL=glm-4.6v-flash`

可选：
- `MODEL_TIMEOUT_MS=45000`
- `POCKETBASE_TIMEOUT_MS=15000`
- `CHAT_PERSIST_TIMEOUT_MS=1500`

## 三、上线后验证

把 `<API_DOMAIN>` 替换成你的 Sealos 域名，测试：

1. `GET <API_DOMAIN>/api/health`
2. `POST <API_DOMAIN>/api/auth/register`
3. `POST <API_DOMAIN>/api/auth/login`

如果 `health` 返回 `ok: true` 且 `pocketbase.configured: true`，说明 API 正常。

## 四、切换 APP 到 Sealos API

### 1) EAS 构建环境变量

把 `EXPO_PUBLIC_API_BASE_URL` 改为 Sealos API 域名（非 Vercel）：

```bash
npx eas-cli env:create --name EXPO_PUBLIC_API_BASE_URL --value https://<API_DOMAIN> --environment preview --type string
npx eas-cli env:create --name EXPO_PUBLIC_API_BASE_URL --value https://<API_DOMAIN> --environment production --type string
```

如果变量已存在，用 `eas env:list / eas env:delete / eas env:create` 方式覆盖。

### 2) 重新打包安卓

```bash
npx eas-cli build -p android --profile preview --non-interactive
```

## 五、故障定位建议

1. 手机浏览器先打开：`https://<API_DOMAIN>/api/health`  
如果这一步打不开，APP 注册一定失败。

2. 如 `register` 报错：
- `该邮箱已注册，请直接登录`：换新邮箱或直接登录
- `密码至少 8 位`：改为 8 位以上密码
- `请求超时`：看 Sealos 实例状态和带宽

3. 如果 Sealos 可访问但 APP 不可访问，优先检查：
- EAS 中 `EXPO_PUBLIC_API_BASE_URL` 是否还是旧的 `vercel.app`
- 安装包是否是最新构建
