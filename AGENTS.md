# 糖罐积分仓库工作规范

本文件适用于仓库内全部目录。开始修改前，先阅读本文件、根目录 `README.md`、`docs/handoff/` 中的最新交接文档，以及 `docs/plans/` 中的当前总体方案。

## 1. 唯一真源与操作边界

- 本仓库 `hefei-points` 是糖罐积分源码与核心文档的唯一 canonical 仓库。
- 保留 `C:\Users\ANGUS\projects\hefei-points\.git` 作为独立仓库元数据；父仓必须忽略并停止跟踪整个 `/hefei-points/`，不得改成 submodule、gitlink 或再次逐文件纳管。
- 不要从父目录 `C:\Users\ANGUS\projects` 管理本项目，也不要在资料目录 `Documents\糖罐积分` 建立另一套源码历史。
- 未经安总明确授权，不修改父仓、远程地址、远端分支或历史。
- 工作区可能包含用户尚未提交的改动；禁止 `reset --hard`、`checkout --`、`clean`、未经授权的 `stash`，也禁止覆盖或丢弃现有修改。

## 2. Git 规则

- `origin` 当前指向专用仓 `git@github.com:anguscwf/hefei-points.git`（2026-08-27 迁移完成）；过渡期间曾共用 `git@github.com:anguscwf/projects.git`，其中 `master` 专属于父 monorepo，与本仓历史无共同祖先。本仓禁止创建、检出、合并或推送 `master`，也不得把 `origin/master` 合入任何本仓分支。
- 本仓长期稳定分支为 `main`，阶段 1 汇总分支为 `codex/stage1`；普通 Codex 主题分支必须使用 `codex/<topic>-YYYYMMDD`。禁止使用含糊的 `master`、`dev`、`tmp` 或无前缀远端分支。
- 每次获准 push 前必须先执行 `git fetch --prune origin`，再用 `git ls-remote --heads origin` 核对目标 ref 和 `master` 未被意外改写。
- push 只能使用完整显式 refspec，例如 `git push origin <local>:refs/heads/<remote>`；禁止裸 `git push`、`git push --all`、`git push --mirror`、任何 force/force-with-lease，以及删除或覆盖 `master`。
- 本地必须设置 `push.default=nothing`，使遗漏显式 refspec 的 push 直接失败。2026-08-27 已完成向专用 `hefei-points` 远端的迁移（决策、默认分支与 18 条 ref OID 已逐条核对一致）；如未来再调整 origin，必须先记录决策、再核对默认分支和全部 ref OID，最后修改 `origin`。
- 只精确暂存本次主题涉及的路径；禁止 `git add .` 与 `git add -A`。
- 每个提交只包含一个主题，提交前检查 `git diff --cached --stat` 和 `git diff --cached`。
- 未经明确授权不得 push、force-push、改远端 refs 或重写历史。
- 父仓历史中的运行数据和旧 `master` 敏感对象属于单独响应事项；普通摘除提交不会清除历史对象，禁止借本规则擅自重写远端历史。

## 3. 永不入库的数据与凭据

以下内容不得提交，即使仅用于调试：

- `data/`、`data-dev/`、`backups/`、`logs/` 及任何真实家庭数据；
- SQLite/数据库文件、WAL/SHM、运行日志和生产备份；
- `.env*`（示例文件除外）、微信私有项目配置；
- HarmonyOS 的真实 `build-profile.json5`、签名密码、证书、Profile、私钥及发布包；
- Access Token、Refresh Token、AppSecret、手机号、设备序列号等敏感信息。

测试必须使用合成家庭与合成账号。发现凭据或真实数据疑似进入 Git 时立即停止暂存/提交，先报告并审计。

## 4. 模块与验证

- `server/`、`scripts/`、`public/`：Node.js 后端、迁移与 Web 静态资源。
- `hefei-miniapp/`：微信小程序家长端。
- `hefei-harmonyos/`：HarmonyOS 孩子端；根 `build-profile.json5` 为本机私有签名配置，不入库。
- `docs/`：交接、总体计划与架构决策。

根目录 Node.js 版本要求见 `package.json`。常规验证：

```bash
npm ci
npm test
npm run check
```

不得为了通过测试连接生产数据库或写入真实家庭数据。HarmonyOS 构建需使用本机 DevEco Studio/SDK 和本地签名配置，提交前同时检查包内 Profile 与签名，但不记录任何秘密值。

## 5. 未成年人和正式发布约束

- 华为官方已确认实名未成年人账号不支持 AppGallery/AppTest 测试分发；儿童真机验收只能在正式上架后进行。
- 上架前只使用成人受控设备、模拟器、合成数据和自动化测试。
- 儿童数据处理、监护人授权、隐私文本、备案和发布门以最新 MVP 方案为准；不得用技术测试绕过未成年人模式。
- 部署、生产迁移、正式提交 AppGallery、发送通知等外部状态变更均需安总单独授权。
