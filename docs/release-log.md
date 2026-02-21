# 发布记录（Release Log）

## 2026-02-21
- 已打包版本：`1.19.0`
- 产物文件：
  - `app-release-v1.19.0.apk`
  - `app-release.apk`
- 规则推导的下次版本：`1.19.1`
- 备注：本次包含键盘贴合优化、机器人风格图标统一、字体加粗。

## 2026-02-21 (续)
- 已打包版本：`1.19.1`
- 产物文件：
  - `app-release-v1.19.1.apk`
  - `app-release.apk`
- 构建结果：`BUILD SUCCESSFUL`
- 附加验证：
  - `npx tsc --noEmit` 通过
  - `node --check server/index.js` 通过
  - `npm run smoke:sealos` 通过（health=200, chat no token=401, internal recap guard=400）

## 2026-02-21 (打包 + 部署)
- 已打包版本：`1.19.2`
- 产物文件：
  - `app-release-v1.19.2.apk`
  - `app-release.apk`
- 版本一致性：
  - `package.json` = `1.19.2`
  - `app.json` = `1.19.2`（`ios.buildNumber=121`，`android.versionCode=121`）
  - `android/app/build.gradle` = `versionName 1.19.2`、`versionCode 121`
- 安装包验收（aapt）：
  - `package: com.tianborobot.app versionName=1.19.2 versionCode=121`
- 后端部署：
  - 已推送提交：`f9c194a`（`feat(chat): add batch history delete endpoint for multi-select cleanup`）
  - Sealos 已执行“变更”并滚动到新 Pod
- 线上验收：
  - `npm run smoke:sealos` 通过
  - `/api/history/delete` 接口验收通过（register -> chat -> delete -> history 再查，删除生效）
- 下次版本：`1.19.3`

## 2026-02-21 (打包)
- 已打包版本：`1.19.3`
- 产物文件：
  - `app-release-v1.19.3.apk`
  - `app-release.apk`
- 版本一致性：
  - `package.json` = `1.19.3`
  - `app.json` = `1.19.3`（`ios.buildNumber=122`，`android.versionCode=122`）
  - `android/app/build.gradle` = `versionName 1.19.3`、`versionCode 122`
- 构建结果：`BUILD SUCCESSFUL`
- 产物路径：`C:\Users\Administrator\Desktop\growup\app-release-v1.19.3.apk`
- 产物大小：`126,275,864` bytes
- 下次版本：`1.19.4`

## 2026-02-22 (打包)
- 已打包版本：`1.19.4`
- 产物文件：
  - `app-release-v1.19.4.apk`
  - `app-release.apk`
- 产物路径：
  - `C:\Users\Administrator\Desktop\app-release-v1.19.4.apk`
  - `C:\Users\Administrator\Desktop\app-release.apk`
- 构建结果：`BUILD SUCCESSFUL`
- 产物大小：`126280836` bytes
- 记录时间：`2026-02-21T17:12:33.969Z`
- 下次版本：`1.19.5`

## 2026-02-22 (打包)
- 已打包版本：`1.19.4`
- 产物文件：
  - `app-release-v1.19.4.apk`
  - `app-release.apk`
- 产物路径：
  - `C:\Users\Administrator\Desktop\app-release-v1.19.4.apk`
  - `C:\Users\Administrator\Desktop\app-release.apk`
- 构建结果：`BUILD SUCCESSFUL`
- 产物大小：`126281884` bytes
- 记录时间：`2026-02-21T18:32:54.126Z`
- 下次版本：`1.19.5`

## 2026-02-22 (打包)
- 已打包版本：`1.19.5`
- 产物文件：
  - `app-release-v1.19.5.apk`
  - `app-release.apk`
- 产物路径：
  - `C:\Users\Administrator\Desktop\app-release-v1.19.5.apk`
  - `C:\Users\Administrator\Desktop\app-release.apk`
- 构建结果：`BUILD SUCCESSFUL`
- 产物大小：`126281884` bytes
- 记录时间：`2026-02-21T18:34:35.784Z`
- 下次版本：`1.19.6`

## 2026-02-22 (打包)
- 已打包版本：`1.19.6`
- 产物文件：
  - `app-release-v1.19.6.apk`
  - `app-release.apk`
- 产物路径：
  - `C:\Users\Administrator\Desktop\app-release-v1.19.6.apk`
  - `C:\Users\Administrator\Desktop\app-release.apk`
- 构建结果：`BUILD SUCCESSFUL`
- 产物大小：`126279956` bytes
- 记录时间：`2026-02-21T18:50:12.592Z`
- 下次版本：`1.19.7`

## 2026-02-22 (打包)
- 已打包版本：`1.19.7`
- 产物文件：
  - `app-release-v1.19.7.apk`
  - `app-release.apk`
- 产物路径：
  - `C:\Users\Administrator\Desktop\app-release-v1.19.7.apk`
  - `C:\Users\Administrator\Desktop\app-release.apk`
- 构建结果：`BUILD SUCCESSFUL`
- 产物大小：`126280164` bytes
- 记录时间：`2026-02-21T19:10:52.621Z`
- 下次版本：`1.19.8`
