# 糖罐积分（hefei-points）

糖罐积分是面向家庭的任务与积分管理系统：家长创建家庭与孩子档案、审批任务和管理积分，孩子通过受控终端查看积分并申报任务。

本仓库是项目源码与核心工程文档的唯一真源。当前基线包含 Node.js 后端、微信小程序家长端、HarmonyOS 孩子端安全纵向切片，以及 S9～S18 的受控 synthetic 本地准备、候选证据封装、外部签名束离线验证、本地授权账本与未提交协调意图能力。S19-readiness 仅新增本地只读外部 saga 阻断报告；真实 S19 外部接入尚未开始。

## 当前状态

- 后端与微信小程序已有历史功能和正在整理的 SQLite/统一服务端改造。
- HarmonyOS `0.2.0 (20000)` 已实现设备安全配对、Access/Refresh 会话轮换、本人摘要/流水、当前可申报规则、文字积分申报和“我的申请”；S9 新增受控临时 synthetic profile 生成器和 loopback 全链验证，S10 又加入纯本地“设置与数据安全”说明。该说明明确不是正式隐私政策、儿童规则、用户协议或同意页面，不读取动态儿童/设备/会话信息，也不提供假解绑或删除按钮。跟踪配置仍固定禁用网络并使用 `.invalid` 源，尚未连接任何外部业务服务，也不代表完整薄 MVP。
- 首个面向实名未成年人账号的版本必须走 AppGallery 正式上架；当前目标与门禁见 [HarmonyOS MVP 方案](docs/plans/糖罐积分鸿蒙版-MVP方案与推进计划.md)。
- 阶段 1 已完成 S0～S18 的安全、授权、配对、本人视图、积分申报、数据行权、两端客户端和 synthetic 运行前置切片。S13 只从完整显式 synthetic 配置创建全新空 `root/data/marker`，或对既有候选根做双轮只读、脱敏核验；S14 为精确空库提供一次性成人管理员、四类获批合成法律元数据和不可变完成回执；S15 把 S12/S13/S14、当前已提交 43 文件/10 迁移、配置、物理根和只读 pristine SQLite/receipt 绑定成短时 machine subject，再把 19 项外部声明包装成未认证信封。S16 只用环境摘要钉住的独立公开策略验证 Ed25519 gate/checkpoint/approval/grant 签名束；S17 只在一个独立本地 ledger 内约束已观察 checkpoint 并记录一次本地 grant 使用。S18 又增加只读历史 receipt 恢复和独立摘要 journal，只能形成 `locally_prepared_unsubmitted` 的本地协调意图。S19-readiness 可以精确只读恢复该历史 intent 并生成固定 `external_integration_blocked` 报告；17 项 blocker 和 14 项能力要求只是非穷尽的最小已知集合，不能证明完整 readiness。它不提交外部请求，不认证权威或真实身份，不提供可信时间、权威最新 checkpoint、跨主机全局消费，也不调用部署器。所有命令始终不授予部署或儿童使用。最终验证结果以最新交接为准，详见 [阶段 1 实施清单](docs/plans/阶段1-现有能力审计与首批实施清单-20260823.md)。
- 生产迁移已增加“旧库一致性快照 + 清单校验 + 无清单拒绝迁移”门禁；但正式法律文本、PIPIA、存量数据整改和 AppGallery 正式上架均未完成，所有儿童生产功能继续默认关闭。
- S0～S18 及 Git 迁移收尾已安全存在于专用远端；S19-readiness 远端主题分支已建立，功能、安全修正与测试提交已显式推送。远端落盘或本地完成都不代表已经部署、联网、上架、完成真实 S19 或开放儿童功能。

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

`npm run prepare:synthetic-data-root` 只在完整 S12 synthetic 配置、候选根现存真实父目录和一次性准备确认都精确匹配时，排他创建全新的空数据根、唯一 `data` 子目录和精确 marker；任何既有或中断残根都拒绝接管。`npm run verify:synthetic-data-root` 只做两轮物理边界核验并输出脱敏 schema 1 readiness 结果。两条命令都不打开 SQLite、不生成运行 secret、不联网、不启动服务、不部署；操作手册见 [受控 synthetic 数据根准备与核验](docs/runbooks/受控-synthetic-数据根准备与核验.md)。

`npm run bootstrap:synthetic-database` 只接受非 TTY stdin 上最多 16 KiB 的单行 canonical JSON，并要求显式 `SYNTHETIC_BOOTSTRAP_ACK=initialize-new-synthetic-database-v1`。管理员密码不得来自参数、环境变量、普通文件或日志；命令只接受 SQLite 路径此前不存在的全新数据根，在同一事务中完成迁移、一个合成成人管理员、四类获批合成法律元数据和不可变回执，故障完整回滚。结果未知时，同一请求与同一凭据可在状态演进前安全恢复；任何内容变化、并发锁、残留 secret、既有 SQLite、未知表或业务数据都 fail closed。服务端 synthetic runtime 没有与当前环境绑定的完成回执时，会在可写打开、迁移和 secret 创建前拒绝启动；操作手册见 [受控 synthetic 初始管理员与法律证据引导](docs/runbooks/受控-synthetic-初始管理员与法律证据引导.md)。

`npm run capture:synthetic-candidate-evidence` 与 `npm run finalize:synthetic-candidate-evidence` 只接受非 TTY stdin 上最多 256 KiB 的单行 canonical JSON，并要求显式 `SYNTHETIC_CANDIDATE_EVIDENCE_ACK=assemble-review-only-not-deployment-v1`。Phase A 使用 schema 4 S12 preflight、S13 空根证据、S14 bootstrap 证据和当前只读数据库生成 30 分钟脱敏 subject；Phase B 重新核验机器状态，只检查 19 个声明信封的顺序、字段、subject 绑定与时效。摘要没有签名，声明未认证，命令不会持久化证据、联网、写 synthetic 数据库或部署；输出始终保留 `externalFactsVerifiedByThisCommand=false`、`deploymentAuthorization=not_granted`、`productionChildGateState=not_observed` 和 `childUseAuthorization=not_granted`。操作手册见 [候选机器证据与未认证声明信封](docs/runbooks/受控-synthetic-候选机器证据与未认证声明信封.md)。

`npm run verify:synthetic-external-approval` 只接受非 TTY stdin 上最多 512 KiB 的单行 canonical JSON，并要求 `SYNTHETIC_EXTERNAL_APPROVAL_ACK=verify-signatures-only-not-deployment-v1`。它从仓库和 synthetic 数据根之外的受控本地文件读取公开 Ed25519 策略，以环境 SHA-256 钉住并前后复核文件身份；随后验证独立吊销 checkpoint、19 项 gate verification、独立 approval 和 5 分钟以内的单次 synthetic grant，同时按历史时刻和当前时刻两次重算 S15。工具不读取外部身份、证据正文或审计记录，不联网、不写数据库、不持久化 sequence/replay/消费状态、不部署；即使签名束有效也只返回 `signed-bundle-valid-against-provided-policy-unconsumed` 和 `deploymentAuthorization=not_granted`。操作手册见 [外部签名束离线验证与未消费授权](docs/runbooks/受控-synthetic-外部签名束离线验证与未消费授权.md)。

`npm run init:synthetic-authorization-ledger` 与 `npm run consume:synthetic-deployment-grant` 只接受非 TTY stdin 上最多 768 KiB 的单行 canonical JSON，并分别要求 `SYNTHETIC_AUTHORIZATION_LEDGER_INIT_ACK=initialize-local-ledger-not-authority-v1` 与 `SYNTHETIC_AUTHORIZATION_CONSUME_ACK=record-local-single-use-not-deployment-v1`。固定文件 `synthetic-authorization-ledger.sqlite` 必须位于仓库、synthetic 数据根和策略目录之外的独立批准父目录，最大 16 MiB，并绑定 ledger、consumer、目标、文件和主机上下文。账本使用 SQLite DELETE journal 与 FULL 同步；WAL/SHM 始终拒绝，正常瞬态或崩溃遗留的 DELETE journal 只由 SQLite 在可写排他锁内恢复。初始化记录签名 checkpoint genesis；消费重跑 S16 verifier 并要求 schema 2 结果，在同一 `BEGIN IMMEDIATE` 中推进有效 checkpoint、累计吊销集合并提交本地使用记录，并对授权束终态失败或唯一性冲突持久化稳定拒绝。写入只发生在独立账本，不写 synthetic/生产数据库、不联网、不调用部署器；`local_single_use_record_committed` 只表示本 ledger 实例已提交本地单次使用记录，不是实际部署、外部权威或全局消费证明。操作手册见 [本地授权账本初始化与单次消费记录](docs/runbooks/受控-synthetic-本地授权账本初始化与单次消费记录.md)。

`npm run prepare:synthetic-authority-coordination-intent` 只接受非 TTY stdin 上最多 1 MiB 的单行 canonical JSON，并要求 `SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ACK=prepare-local-intent-not-submitted-v1`。首次运行会先只读恢复精确历史 S17 receipt，成功后才在仓库、数据根、策略和 S17 ledger 之外创建独立 `synthetic-authority-coordination-intent.sqlite`；缺失 receipt、历史 rejection 或 S17 journal 活动时不会隐式消费或创建 S18 journal。该 journal 只保存摘要与非敏感元数据，在本文件内执行 request/receipt/grant/approval/候选唯一性和本机观察时间高水位，结果始终是 `locally_prepared_unsubmitted`。它不具备外部防回滚锚，不证明跨 journal/主机全局消费，不联网、不提交外部请求、不调用部署器。操作手册见 [权威协调意图本地准备](docs/runbooks/受控-synthetic-权威协调意图本地准备.md)。

`npm run report:synthetic-external-saga-blockers` 只接受非 TTY stdin 上最多 1 MiB 的单行 canonical JSON，并要求 `SYNTHETIC_EXTERNAL_SAGA_READINESS_ACK=report-blockers-no-external-action-v1`。它使用 S18 的只读恢复 API 绑定精确历史 intent，输出固定 `readyForExternalIntegration=false`、`blockerSetCompleteness=minimum_known_non_exhaustive` 和全部未授权状态；不新增数据库、journal、operation ID、reservation、outbox 或 fence，也不联网、提交、部署、补偿或回滚。命令环境必须完全不含 `WX_APPSECRET`；检测键存在时会在 recovery 前拒绝且不读取值。退出码 0 只表示阻断报告成功生成，不表示 readiness 通过。操作手册见 [外部 saga 阻断报告](docs/runbooks/受控-synthetic-外部saga阻断报告.md)。

服务端公开法律证据还要求显式配置精确 HTTPS 源 `LEGAL_PUBLIC_ORIGIN`。四类文本和监护关系声明的 URL 必须严格等于 `/legal/<固定文本类型>/<版本>/<小写 SHA-256>.html`；配置缺失、跨域、类型/版本/摘要路径不匹配时统一视为 `LEGAL_TEXTS_UNAVAILABLE`。正式文本、重定向、CSP、微信业务域名及真机加载验证仍属于生产硬门。

HarmonyOS 工程使用 DevEco Studio 打开 `hefei-harmonyos/`。根 `hefei-harmonyos/build-profile.json5` 含本机签名信息并被强制忽略；开发者必须在本机独立配置，严禁提交密码、证书、Profile 或绝对路径。

HarmonyOS 主源码关闭备份恢复和动态敏感日志，设备私钥使用 HUKS ECE，设备会话与未决积分申请使用相互独立、不可同步的 AssetStore 记录。`npm run prepare:harmonyos-synthetic` 只会把 Git 跟踪的 HarmonyOS 普通文件复制到本机系统临时目录，生成明确 unsigned、来源可追踪的临时 profile；它要求显式确认获批的非生产 canonical HTTPS 源，拒绝生产域、UNC、仓库内/非临时目录、符号链接和签名类输入，并且命令本身不联网。S10 的本地安全壳还由封闭入口、固定导出面和对抗夹具约束，切换或退到后台会清短码与积分草稿。当前只完成 unsigned ArkTS 单测、静态检查、loopback HTTP 全链和临时 profile 编译；独立合成非生产 API、HUKS/AssetStore 成人受控设备验证、联网端到端 smoke 和签名包验证仍是硬门。

## 文档入口

- [仓库工作规范](AGENTS.md)
- [最新开发交接](docs/handoff/Codex-糖罐积分阶段1-S19-readiness外部saga阻断报告交接-20260829.md)
- [S13 数据根操作手册](docs/runbooks/受控-synthetic-数据根准备与核验.md)
- [S14 初始引导操作手册](docs/runbooks/受控-synthetic-初始管理员与法律证据引导.md)
- [S15 候选证据操作手册](docs/runbooks/受控-synthetic-候选机器证据与未认证声明信封.md)
- [S16 外部签名束离线验证操作手册](docs/runbooks/受控-synthetic-外部签名束离线验证与未消费授权.md)
- [S17 本地授权账本操作手册](docs/runbooks/受控-synthetic-本地授权账本初始化与单次消费记录.md)
- [S18 权威协调意图本地准备操作手册](docs/runbooks/受控-synthetic-权威协调意图本地准备.md)
- [S19-readiness 外部 saga 阻断报告操作手册](docs/runbooks/受控-synthetic-外部saga阻断报告.md)
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
