# 糖罐积分（hefei-points）

糖罐积分是面向家庭的任务与积分管理系统：家长创建家庭与孩子档案、审批任务和管理积分，孩子通过受控终端查看积分并申报任务。

本仓库是项目源码与核心工程文档的唯一真源。当前基线包含 Node.js 后端、微信小程序家长端、HarmonyOS 孩子端的 S10 本地设置与隐私安全壳，以及 S11 小程序受控 synthetic 工作区。

## 当前状态

- 后端与微信小程序已有历史功能和正在整理的 SQLite/统一服务端改造。
- HarmonyOS `0.2.0 (20000)` 已实现设备安全配对、Access/Refresh 会话轮换、本人摘要/流水、当前可申报规则、文字积分申报和“我的申请”；S9 新增受控临时 synthetic profile 生成器和 loopback 全链验证，S10 又加入纯本地“设置与数据安全”说明。该说明明确不是正式隐私政策、儿童规则、用户协议或同意页面，不读取动态儿童/设备/会话信息，也不提供假解绑或删除按钮。跟踪配置仍固定禁用网络并使用 `.invalid` 源，尚未连接任何外部业务服务，也不代表完整薄 MVP。
- 首个面向实名未成年人账号的版本必须走 AppGallery 正式上架；当前目标与门禁见 [HarmonyOS MVP 方案](docs/plans/糖罐积分鸿蒙版-MVP方案与推进计划.md)。
- 阶段 1 已在本地完成 S0、安全前置、S1/006 授权建档、S2/007 设备配对与会话、S3 孩子本人只读、S4/008 积分申报审批、S5/009 数据行权与审计、S6 微信小程序监护端及安全加固、S7 HarmonyOS 配对/会话/本人只读、S8 HarmonyOS 积分申报、S9 合成 E2E 就绪、S10 本地设置与隐私安全壳，以及 S11 小程序受控 synthetic 工作区。S11 只从与 `HEAD` 完全一致的 Git index blob 生成系统临时副本，以独立 synthetic AppID 和获批非生产源替换两份编译配置；不读取工作树或私有项目配置，不联网、不启动 DevTools、不 preview/upload。它只推进成人受控预发布准备，不是外部联网或儿童可用版本。详见 [阶段 1 实施清单](docs/plans/阶段1-现有能力审计与首批实施清单-20260823.md)。
- 生产迁移已增加“旧库一致性快照 + 清单校验 + 无清单拒绝迁移”门禁；但正式法律文本、PIPIA、存量数据整改和 AppGallery 正式上架均未完成，所有儿童生产功能继续默认关闭。
- 当前阶段 1 变更仍只存在于本地分支，不代表已部署、已上架或已清理远端历史。

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

存在待执行迁移的生产旧库必须先运行：

```bash
npm run backup:pre-migration -- --database <旧库路径> --backup-root <备份目录>
```

再将命令输出的 `manifest.json` 路径设置为 `PRE_MIGRATION_BACKUP_MANIFEST` 后启动新代码。日常 `npm run backup` 是迁移后的运行备份，不能替代该门禁。

生产开启 `DEVICE_PAIRING_ENABLED` 前还必须显式设置 `PAIRING_CLIENT_IP_MODE=direct`，或设置 `PAIRING_CLIENT_IP_MODE=trusted_proxy` 并通过 `TRUSTED_PROXIES` 列出实际代理 IP/CIDR。服务默认不信任转发地址头，避免伪造来源绕过持久猜码锁；该配置不替代边缘限流。

孩子本人只读接口严格只接受设备 Access Bearer。摘要接口不接受查询参数；流水接口只接受 `limit`（1～50，默认 20）和服务端签发、作用域绑定的 AEAD 不透明游标。客户端提交家庭、儿童、设备或会话选择字段会被拒绝，响应不返回家庭、设备、会话、家长姓名或内部备注。

积分申报同样严格使用设备 Access 身份并由 `POINT_REQUESTS_ENABLED` 独立控制。设备先通过 `GET /api/v2/me/reward-rules` 读取当前家庭可申报鼓励规则的最小快照，再提交规则、积分和文字说明；服务端保存规则快照。家长待办、退回、批准或驳回都要求本人当前有效监护授权。规则和申请游标均绑定家庭、儿童、设备或角色作用域；跨设备共享申请视图不会回显来源设备的客户端请求 ID。普通补报期限待产品确认，当前先只接受上海自然日内的实际发生时间。批准与入账原子执行，未批准申请不影响余额；客户端不得提交家庭、儿童、设备、分类或流水来源字段。

儿童数据权利创建入口固定为 `POST /api/v2/children/:id/data-rights-requests`。查阅、导出和别名更正由 `CHILD_DATA_RIGHTS_ENABLED` 独立控制；撤回授权、删除、终止服务、既有请求详情和已授权的短时动态导出不依赖 Harmony 总门，以免止损开关反而封死安全或法定入口。每种动作使用独立重新认证 purpose；别名更正不改写历史账本或审批快照。撤回、删除与终止都会同步推进旧儿童 Token 失效下限；删除与终止只会原子进入 `deletion_pending`、撤销目标儿童设备并生成 `blocked_policy` 作业。逐类留存政策未获批前绝不执行、去标识化或宣称完成删除。

小程序会在普通数据行权写入前持久化并回读一个不含密码、重新认证断言、正文或别名的恢复句柄；结果未知时只能用原 `Idempotency-Key` 重试或调用 `GET /api/v2/data-rights-operations/request-create` 对账。对账按当前成人、家庭、操作和键隔离，完成后还必须读取本人请求详情并核对儿童与请求类型，才能清理本地阻断状态。

小程序运行环境只由编译时 `envVersion` 选择。`release` 精确绑定 `https://hefeijifen.cn`；在独立合成非生产 API 获批并写入受控配置前，`develop`、`trial` 和未知环境全部使用不可路由占位源且在调用 `wx.request` 前返回 `API_ENVIRONMENT_INVALID`。运行时不读取本地存储、ext config 或启动参数覆盖域名。跟踪的 `project.config.json` 要求 `urlCheck: true`；微信开发者工具中被忽略的个人配置仍须在 smoke 前人工确认没有关闭域名校验。

`npm run prepare:miniapp-synthetic` 只在操作员同时确认获批 synthetic origin 和独立 synthetic AppID 后，向全新的系统临时目录生成 develop/trial 专用副本；release/unknown 在副本中固定 fail closed。生成器锁定完整小程序源码树和仅有的 legacy/v2/legal 网络链路，禁用 Git pager、fsmonitor、lazy fetch 与可选锁，并让原子目录 rename 成为成功路径的最后一步。manifest 明确标记 AppID provisioning、开发者权限、request/business domain、DevTools 私有配置和基础设施连通均未外部验证；这些仍是联网 smoke 的前置硬门。

服务端公开法律证据还要求显式配置精确 HTTPS 源 `LEGAL_PUBLIC_ORIGIN`。四类文本和监护关系声明的 URL 必须严格等于 `/legal/<固定文本类型>/<版本>/<小写 SHA-256>.html`；配置缺失、跨域、类型/版本/摘要路径不匹配时统一视为 `LEGAL_TEXTS_UNAVAILABLE`。正式文本、重定向、CSP、微信业务域名及真机加载验证仍属于生产硬门。

HarmonyOS 工程使用 DevEco Studio 打开 `hefei-harmonyos/`。根 `hefei-harmonyos/build-profile.json5` 含本机签名信息并被强制忽略；开发者必须在本机独立配置，严禁提交密码、证书、Profile 或绝对路径。

HarmonyOS 主源码关闭备份恢复和动态敏感日志，设备私钥使用 HUKS ECE，设备会话与未决积分申请使用相互独立、不可同步的 AssetStore 记录。`npm run prepare:harmonyos-synthetic` 只会把 Git 跟踪的 HarmonyOS 普通文件复制到本机系统临时目录，生成明确 unsigned、来源可追踪的临时 profile；它要求显式确认获批的非生产 canonical HTTPS 源，拒绝生产域、UNC、仓库内/非临时目录、符号链接和签名类输入，并且命令本身不联网。S10 的本地安全壳还由封闭入口、固定导出面和对抗夹具约束，切换或退到后台会清短码与积分草稿。当前只完成 unsigned ArkTS 单测、静态检查、loopback HTTP 全链和临时 profile 编译；独立合成非生产 API、HUKS/AssetStore 成人受控设备验证、联网端到端 smoke 和签名包验证仍是硬门。

## 文档入口

- [仓库工作规范](AGENTS.md)
- [最新开发交接](docs/handoff/Codex-糖罐积分阶段1-S11小程序合成工作区交接-20260826.md)
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
