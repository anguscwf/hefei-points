# 2026-08-20 canonical 仓库基线记录

## 1. 范围与结论

- canonical 仓库：`C:\Users\ANGUS\projects\hefei-points`
- 基线起点：`main@f48cc69`
- 本地工作分支：`codex/repo-baseline-20260820`
- 本轮不修改父仓、不修改远程、不推送、不重写历史、不部署。
- 父仓覆盖造成的 server 与 miniapp 旧版本工作树已恢复到 v2.5 一致语义后再提交；没有将已知回退状态包装成新功能。

## 2. 分批提交清单

### `4ec6cc4 docs(baseline): establish canonical repository governance`（8 个文件）

用途：确定唯一真源、安全边界、文档入口和后续远程/历史处置规则。

```text
.gitignore
AGENTS.md
README.md
docs/adr/0001-canonical-standalone-repository.md
docs/adr/0002-sensitive-data-and-build-boundaries.md
docs/adr/README.md
docs/handoff/Codex-糖罐积分开发交接指令-20260820.md
docs/plans/糖罐积分鸿蒙版-MVP方案与推进计划.md
```

### `733901c chore(baseline): stop tracking local assistant memory`（4 个文件）

用途：从 canonical 索引移除本地助手记忆；文件仍保留在本机并由 `.gitignore` 隔离。

```text
.workbuddy/memory/2026-05-06.md
.workbuddy/memory/2026-05-07.md
.workbuddy/memory/2026-05-08.md
.workbuddy/memory/MEMORY.md
```

### `90ac495 feat(harmonyos): establish stage 0 diagnostic client baseline`（33 个文件）

用途：纳入 HarmonyOS 阶段 0 诊断客户端的 ArkTS、资源和安全模块配置。根级真实签名配置不在清单中。

```text
hefei-harmonyos/.gitignore
hefei-harmonyos/README.md
hefei-harmonyos/code-linter.json5
hefei-harmonyos/hvigorfile.ts
hefei-harmonyos/oh-package.json5
hefei-harmonyos/oh-package-lock.json5
hefei-harmonyos/AppScope/app.json5
hefei-harmonyos/AppScope/resources/base/element/string.json
hefei-harmonyos/AppScope/resources/base/media/background.png
hefei-harmonyos/AppScope/resources/base/media/brand_icon.png
hefei-harmonyos/AppScope/resources/base/media/foreground.png
hefei-harmonyos/AppScope/resources/base/media/layered_image.json
hefei-harmonyos/hvigor/hvigor-config.json5
hefei-harmonyos/entry/.gitignore
hefei-harmonyos/entry/build-profile.json5
hefei-harmonyos/entry/hvigorfile.ts
hefei-harmonyos/entry/obfuscation-rules.txt
hefei-harmonyos/entry/oh-package.json5
hefei-harmonyos/entry/src/main/module.json5
hefei-harmonyos/entry/src/main/ets/entryability/EntryAbility.ets
hefei-harmonyos/entry/src/main/ets/entrybackupability/EntryBackupAbility.ets
hefei-harmonyos/entry/src/main/ets/pages/Index.ets
hefei-harmonyos/entry/src/main/resources/base/element/color.json
hefei-harmonyos/entry/src/main/resources/base/element/float.json
hefei-harmonyos/entry/src/main/resources/base/element/string.json
hefei-harmonyos/entry/src/main/resources/base/media/background.png
hefei-harmonyos/entry/src/main/resources/base/media/brand_icon.png
hefei-harmonyos/entry/src/main/resources/base/media/foreground.png
hefei-harmonyos/entry/src/main/resources/base/media/layered_image.json
hefei-harmonyos/entry/src/main/resources/base/media/startIcon.png
hefei-harmonyos/entry/src/main/resources/base/profile/backup_config.json
hefei-harmonyos/entry/src/main/resources/base/profile/main_pages.json
hefei-harmonyos/entry/src/main/resources/dark/element/color.json
```

说明：`hefei-harmonyos/entry/build-profile.json5` 是无签名秘密的模块编译配置；被忽略的是根级 `hefei-harmonyos/build-profile.json5`。

### `d4f15f9 chore(baseline): archive legacy server layouts`（10 个变更项）

用途：把旧 development/production/单文件服务端收敛到 `archive/`，删除重复入口，保留历史参考。

```text
production/clean-history.sh -> archive/clean-history.sh
production/deploy-dev.sh -> archive/deploy-dev.sh
development/index.html -> archive/index-development-pre-refactor.html
production/index.html -> archive/index-production-pre-refactor.html
development/server.js -> archive/server-development-pre-refactor.js
production/server.js -> archive/server-production-pre-refactor.js
archive/server-v2.2-legacy.js
archive/server-v3.1.js
server-v4.0.js -> archive/server-v4.0.js
server-v3.1.js（删除重复根入口）
```

### `1dd7dc3 chore(baseline): add shared brand assets`（6 个文件）

用途：纳入糖罐文字 Logo 的可复现 HTML 源与常用尺寸导出图，统一旧 SVG 品牌字样。

```text
assets/brand-logo/糖罐积分-文字Logo-1024x1024.png
assets/brand-logo/糖罐积分-文字Logo-144x144.png
assets/brand-logo/糖罐积分-文字Logo-256x256.png
assets/brand-logo/糖罐积分-文字Logo-512x512.png
assets/brand-logo/糖罐积分-文字Logo-v1.html
hepai-logo.svg
```

### `107e283 feat(server): establish modular SQLite backend baseline`（32 个文件）

用途：建立统一 Express 入口、SQLite 连接/迁移/仓储、鉴权、中间件、备份脚本和质量测试；同时保持 v2.5 稳定规则 ID、revision、规则历史及流水关联测试通过。

```text
backup.sh
ecosystem.config.js
index.html
package-lock.json
package.json
public/index.html
scripts/backup-sqlite.js
scripts/check-rename.js
scripts/check-rename.sh
scripts/configure-pm2-logrotate.js
scripts/migrate-json-to-sqlite.js
server/config/env.js
server/db/connection.js
server/db/migrations/001_init.sql
server/db/migrations/002_token_revocation.sql
server/db/migrations/003_transaction_soft_delete.sql
server/db/repositories/index.js
server/db/repositories/users.js
server/index.js
server/lib/backup.js
server/lib/json-store.js
server/lib/token.js
server/lib/wx-auth.js
server/middleware/cache-control.js
server/middleware/rate-limit.js
server/middleware/request-logger.js
server/routes/auth.js
server/routes/backup.js
server/routes/family.js
server/routes/health.js
server/routes/history.js
test/quality.test.js
```

### `df509c4 feat(miniapp): document v2.5 client baseline`（1 个文件）

用途：明确小程序 v2.5 稳定规则 ID/历史语义、本地配置边界和验证方法。

```text
hefei-miniapp/README.md
```

父仓曾将以下工作树覆盖为 v2.1/v2.4；经历史 blob 与功能差异核对，全部精确恢复为既有 `bd06268` v2.5 内容，因此没有制造重复的小程序源码提交：

```text
hefei-miniapp/app.js
hefei-miniapp/app.json
hefei-miniapp/components/action-sheet/action-sheet.js
hefei-miniapp/components/action-sheet/action-sheet.wxml
hefei-miniapp/components/action-sheet/action-sheet.wxss
hefei-miniapp/pages/admin/admin.js
hefei-miniapp/pages/admin/admin.wxml
hefei-miniapp/pages/admin/admin.wxss
hefei-miniapp/pages/index/index.js
hefei-miniapp/pages/index/index.wxml
hefei-miniapp/pages/index/index.wxss
hefei-miniapp/pages/mine/mine.js
hefei-miniapp/pages/mine/mine.wxml
hefei-miniapp/pages/mine/mine.wxss
hefei-miniapp/pages/report/report.js
hefei-miniapp/pages/report/report.wxml
hefei-miniapp/pages/report/report.wxss
hefei-miniapp/project.config.json
```

### `5d44849 docs(baseline): archive miniapp rule UI proposal`（2 个文件）

用途：将旧规则界面方案归入历史产品资料，并标明其中部分“未来工作”已被 v2.5 实现。

```text
README.md
docs/product/规则界面优化方案-历史.md
```

## 3. 验证结果

- `npm test`：29/29 通过；
- `npm run check`：通过；
- 小程序 6 个受影响 JS 文件：`node --check` 通过；
- `hefei-miniapp/app.json`、`project.config.json`：JSON 解析通过；
- HarmonyOS：DevEco CLI `build clean` 与 debug build 均成功；
- Git 工作树：无 tracked/untracked 变更；
- 忽略验证：`data/`、`data-dev/`、`backups/`、`logs/`、私有小程序配置和根级 HarmonyOS 签名配置均命中 `.gitignore`；
- tracked 文件扫描：没有私钥头、签名密码字段、证书/Profile/发布包或大陆手机号命中。

## 4. 后续安全与仓库任务

1. 为 `hefei-points` 创建独立远程，停止与父仓共用 `projects.git`；
2. 单独授权后让父仓停止索引跟踪 `hefei-points/`，但不删除工作目录；
3. 审计父仓本地及远端历史中的家庭数据、SQLite、备份和私有配置；
4. 核实远端 `main`/`master` 的用途与协作者，再决定默认分支和归档策略；
5. 发布前轮换已暴露风险的 HarmonyOS 签名凭据，并重新核验签名链；
6. 生产部署前复核 PM2 环境变量注入、重启策略与备份恢复演练；
7. 将当前默认孩子密码兼容路径替换为监护人授权的一次性设备配对机制。
