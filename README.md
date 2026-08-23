# 糖罐积分（hefei-points）

糖罐积分是面向家庭的任务与积分管理系统：家长创建家庭与孩子档案、审批任务和管理积分，孩子通过受控终端查看积分并申报任务。

本仓库是项目源码与核心工程文档的唯一真源。当前基线包含 Node.js 后端、微信小程序家长端，以及 HarmonyOS 孩子端的阶段 0 工程。

## 当前状态

- 后端与微信小程序已有历史功能和正在整理的 SQLite/统一服务端改造。
- HarmonyOS `0.1.0` 是技术诊断版本，只验证 ArkTS、HTTPS、存储、生命周期及签名链，不包含完整业务闭环。
- 首个面向实名未成年人账号的版本必须走 AppGallery 正式上架；当前目标与门禁见 [HarmonyOS MVP 方案](docs/plans/糖罐积分鸿蒙版-MVP方案与推进计划.md)。
- 阶段 1 已在本地完成 S0、安全前置、S1/006 授权建档、S2/007 设备配对与会话、S3 孩子本人只读、S4/008 积分申报审批、S5/009 数据行权与审计，以及 S6 微信小程序监护端代码切片：设备短码/凭据只落摘要，Access/Refresh 单次轮换和授权撤回级联已落地；本人查询和申报只从当前设备 Access 会话推导儿童身份；批准申请以 revision 竞争原子生成唯一来源流水；查阅、导出、更正、撤回、删除和终止服务均绑定本人监护证据、动作专用重新认证与不可变审计；小程序新增授权向导、设备管理、家庭待办和家庭与隐私入口，并对结果未知写入保留原幂等意图。详见 [阶段 1 实施清单](docs/plans/阶段1-现有能力审计与首批实施清单-20260823.md)。
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

积分申报同样严格使用设备 Access 身份并由 `POINT_REQUESTS_ENABLED` 独立控制。孩子提交当前家庭 reward 规则和文字说明，服务端保存规则快照；家长待办、退回、批准或驳回都要求本人当前有效监护授权。设备和家长列表均使用作用域绑定的 AEAD 不透明游标；跨设备共享视图不会回显来源设备的客户端请求 ID。普通补报期限待产品确认，当前先只接受上海自然日内的实际发生时间。批准与入账原子执行，未批准申请不影响余额；客户端不得提交家庭、儿童、设备、分类或流水来源字段。

儿童数据权利创建入口固定为 `POST /api/v2/children/:id/data-rights-requests`。查阅、导出和别名更正由 `CHILD_DATA_RIGHTS_ENABLED` 独立控制；撤回授权、删除、终止服务、既有请求详情和已授权的短时动态导出不依赖 Harmony 总门，以免止损开关反而封死安全或法定入口。每种动作使用独立重新认证 purpose；别名更正不改写历史账本或审批快照。撤回、删除与终止都会同步推进旧儿童 Token 失效下限；删除与终止只会原子进入 `deletion_pending`、撤销目标儿童设备并生成 `blocked_policy` 作业。逐类留存政策未获批前绝不执行、去标识化或宣称完成删除。

HarmonyOS 工程使用 DevEco Studio 打开 `hefei-harmonyos/`。根 `hefei-harmonyos/build-profile.json5` 含本机签名信息并被强制忽略；开发者必须在本机独立配置，严禁提交密码、证书、Profile 或绝对路径。

## 文档入口

- [仓库工作规范](AGENTS.md)
- [最新开发交接](docs/handoff/Codex-糖罐积分阶段1-S6小程序监护端交接-20260824.md)
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
