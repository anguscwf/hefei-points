# 糖罐积分仓库工作规范

本文件适用于仓库内全部目录。开始修改前，先阅读本文件、根目录 `README.md`、`docs/handoff/` 中的最新交接文档，以及 `docs/plans/` 中的当前总体方案。

## 1. 唯一真源与操作边界

- 本仓库 `hefei-points` 是糖罐积分源码与核心文档的唯一 canonical 仓库。
- 不要从父目录 `C:\Users\ANGUS\projects` 管理本项目，也不要在资料目录 `Documents\糖罐积分` 建立另一套源码历史。
- 未经安总明确授权，不修改父仓、远程地址、远端分支或历史。
- 工作区可能包含用户尚未提交的改动；禁止 `reset --hard`、`checkout --`、`clean`、未经授权的 `stash`，也禁止覆盖或丢弃现有修改。

## 2. Git 规则

- Codex 分支默认使用 `codex/` 前缀。
- 只精确暂存本次主题涉及的路径；禁止 `git add .` 与 `git add -A`。
- 每个提交只包含一个主题，提交前检查 `git diff --cached --stat` 和 `git diff --cached`。
- 未经明确授权不得 push、force-push、改远端 refs 或重写历史。
- 当前父仓双重跟踪、远端 `main`/`master` 并存及敏感历史问题，按 `docs/adr/` 记录另案处理。

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

