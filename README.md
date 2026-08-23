# 糖罐积分（hefei-points）

糖罐积分是面向家庭的任务与积分管理系统：家长创建家庭与孩子档案、审批任务和管理积分，孩子通过受控终端查看积分并申报任务。

本仓库是项目源码与核心工程文档的唯一真源。当前基线包含 Node.js 后端、微信小程序家长端，以及 HarmonyOS 孩子端的阶段 0 工程。

## 当前状态

- 后端与微信小程序已有历史功能和正在整理的 SQLite/统一服务端改造。
- HarmonyOS `0.1.0` 是技术诊断版本，只验证 ArkTS、HTTPS、存储、生命周期及签名链，不包含完整业务闭环。
- 首个面向实名未成年人账号的版本必须走 AppGallery 正式上架；当前目标与门禁见 [HarmonyOS MVP 方案](docs/plans/糖罐积分鸿蒙版-MVP方案与推进计划.md)。
- 阶段 1 已完成现有后端与小程序的代码级复用审计；下一项实施任务是先关闭旧接口的儿童数据暴露，再进入授权建档，详见 [阶段 1 实施清单](docs/plans/阶段1-现有能力审计与首批实施清单-20260823.md)。
- 本轮只建立本地 canonical 基线，不代表已部署、已上架或已清理远端历史。

## 目录

```text
hefei-points/
├─ server/             Node.js/Express API、鉴权、数据访问与路由
├─ scripts/            数据迁移、备份和工程检查脚本
├─ public/             Web 静态资源
├─ hefei-miniapp/      微信小程序家长端
├─ hefei-harmonyos/    HarmonyOS 孩子端
├─ test/               根级质量测试
└─ docs/
   ├─ adr/             架构决策记录
   ├─ handoff/         开发交接指令
   ├─ plans/           当前总体方案与推进计划
   └─ product/         历史产品与实施方案
```

`data/`、`data-dev/`、`backups/` 和 `logs/` 是本地运行目录，不属于源码。

## 本地启动与验证

要求 Node.js `>=22.5.0`：

```bash
npm ci
npm test
npm run check
npm run dev
```

`npm run dev` 使用被 Git 忽略的 `data-dev/`。任何测试均应使用合成家庭和合成账号，不得连接或复制真实家庭数据。

HarmonyOS 工程使用 DevEco Studio 打开 `hefei-harmonyos/`。根 `hefei-harmonyos/build-profile.json5` 含本机签名信息并被强制忽略；开发者必须在本机独立配置，严禁提交密码、证书、Profile 或绝对路径。

## 文档入口

- [仓库工作规范](AGENTS.md)
- [最新开发交接](docs/handoff/Codex-糖罐积分开发交接指令-20260820.md)
- [HarmonyOS MVP 方案与推进计划](docs/plans/糖罐积分鸿蒙版-MVP方案与推进计划.md)
- [阶段 1 现有能力审计与首批实施清单](docs/plans/阶段1-现有能力审计与首批实施清单-20260823.md)
- [架构决策记录](docs/adr/README.md)
- [2026-08-20 canonical 仓库基线记录](docs/baseline/2026-08-20-repository-baseline.md)
- [历史规则界面优化方案](docs/product/规则界面优化方案-历史.md)

## 安全与 Git 基线

- 精确暂存，禁止 `git add .` 和 `git add -A`。
- 不提交运行数据、备份、日志、真实账号、令牌、签名材料或私有项目配置。
- 不从父仓 `C:\Users\ANGUS\projects` 管理本项目。
- 未经安总明确授权，不 push、不改远程、不部署、不提交 AppGallery，也不重写历史。
- 父仓双重跟踪、远端双分支和敏感历史审计属于后续独立任务，详见 [ADR-0001](docs/adr/0001-canonical-standalone-repository.md)。
