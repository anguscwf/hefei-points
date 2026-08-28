# 糖罐积分阶段 1 / S19-readiness 外部 saga 阻断报告交接（2026-08-29）

## 当前状态

- canonical 仓库：`C:\Users\ANGUS\projects\hefei-points`
- 分支：`codex/stage1-s19-integration-readiness-20260828`
- 起始 HEAD：`acb05c6 docs(stage1): record local authority coordination boundary`
- 功能提交：`872c994 feat(synthetic): add fail-closed saga blocker reporting`
- 测试提交：`0803ee1 test(synthetic): cover saga blocker safety`
- provenance 排序修正：`839d161 fix(synthetic): preserve provenance path ordering`
- 审计语义修正：`225df71 fix(synthetic): clarify saga blocker audit semantics`
- 远端主题分支已建立，上述代码、测试和修正均已用完整 refspec 显式推送；`git ls-remote` 已核验到 `225df711deb396d559c292876ff6351c647d11a6`。本文档提交将在最终验证后继续推送同一分支。
- 未部署、未修改生产服务器、未连接外部 authority/coordinator/deployer、未读取或复制生产数据，也未读取真实 AppSecret、私钥、证书、签名材料或设备标识。

准确阶段结论：S0～S18 已完成；S19-readiness 本地只读 blocker report 已完成；真实 S19 外部 saga 尚未开始，仍被外部硬门阻断。

## 本轮实现

### 1. S18 历史 intent 严格只读恢复

`scripts/support/synthetic-authority-coordination-intent.js` 新增生产 API：

```text
recoverSyntheticAuthorityCoordinationIntent(environment, document)
```

它只接受创建历史 S18 intent 的精确原文：

- 不存在返回 `SYNTHETIC_AUTHORITY_COORDINATION_INTENT_HISTORICAL_INTENT_REQUIRED`；
- 同 request ID 异指纹返回稳定幂等冲突；
- 成功固定 `outcome=replayed`，不调用 S17、不重新消费、不重新验证当前外部批准或本机时间；
- 输出固定 `localIntentJournalOpenedReadOnly=true`、`localIntentJournalOpenedWritable=false`、`coordinationIntentRowInserted=false`；
- 不写 journal、synthetic 数据库或其他状态。

S17 和 S18 read-only recovery 同步加固：开库前持有 `O_RDONLY` fd，校验普通单链接 SQLite、DELETE header 和全文件 SHA-256，固定 `query_only=ON` 与 `temp_store=MEMORY`，在普通读事务前后重复核对 path、realpath、文件身份与完整摘要。`-journal` 不由只读入口恢复；`-wal/-shm` 或无 sidecar 的持久 WAL header 均在 DatabaseSync 打开前 fail closed，目录保持零变化。

### 2. 固定阻断报告

新增：

```text
npm run report:synthetic-external-saga-blockers
```

CLI 要求：

```text
SYNTHETIC_EXTERNAL_SAGA_READINESS_ACK=report-blockers-no-external-action-v1
```

输入只允许一个精确历史 S18 document；调用方不能提供 endpoint、credential、trust root、authority response、外部 receipt 或任何成功/verified 声明。生产 API 不接受 test recovery override。

成功输出固定：

```text
profile=synthetic-external-saga-readiness-blocker-report
result=external_integration_blocked
scope=local_read_only_blocker_report
readyForExternalIntegration=false
blockerSetCompleteness=minimum_known_non_exhaustive
checks.overallDeploymentReadinessAssessed=false
deploymentAuthorization=not_granted
productionChildGateState=not_observed
childUseAuthorization=not_granted
```

17 个 blocker 与 14 个 required capability 采用固定排序和 canonical 摘要，但只表示本版本“非穷尽的最小已知集合”。它们不是权威事实、签名、完整部署检查表或批准。

### 3. 最小权限与审计语义

- 环境中只要存在 `WX_APPSECRET` 键，就在 S18 recovery 前拒绝；实现不读取其值；
- 真实 S16 策略文件与父目录环境名均进入 raw-input 敏感值过滤；
- 命令会在内存中读取完整精确 S18 document，但不持久化输入；
- `rawAuthorizationMaterialExcludedFromReport=true` 只描述输出不回显原材料；
- `credentialsRead=false`、网络/提交/reservation/部署/补偿/生产数据读取/儿童门变更均为 false；
- exit 0 只代表 blocker report 成功生成，不代表 readiness 通过。

### 4. 明确没有实现的 S19 能力

本轮没有新增 endpoint、SDK、凭据、trust root、网络、外部协议适配器、全局 operation ID、reservation、durable outbox、fence、target admission、部署回执、独立观察、补偿、回滚或 migration 011；也没有创建新的本地 readiness journal。S16 `unconsumed`、S17 local receipt、S18 `locally_prepared_unsubmitted` 和本报告都不能升级为外部许可。

## provenance 与迁移

- committed synthetic preflight 当前精确锁定 43 个实现文件；
- 新 blocker CLI 与支持模块已进入四处一致、按 Git 路径排序的锁定清单；
- 业务迁移仍精确为 001～010，共 10 项；
- 没有 migration 011，没有新业务表或持久 readiness 状态。

## 安全与回归

测试只使用合成配置、内存测试替身、系统临时目录和临时 SQLite，覆盖：

- S17/S18 exact read-only recovery、历史缺失/冲突、production/test 隔离与零写；
- S17/S18 持久 WAL header 但无 sidecar 的开库前拒绝与目录零变化；
- held fd/full hash/path identity 的事务内重复校验；
- live writer、真实 hot DELETE journal、SIGKILL、结果未知与可写入口恢复；
- blocker/requirement 固定集合、摘要、全 false 外部事实和全部未授权状态；
- caller 外部事实拒绝、test seam 隔离、无状态、零网、零提交与零部署；
- `WX_APPSECRET` getter 零读取、S18 recovery 零调用、真实策略路径敏感输入拒绝；
- CLI ACK/canonical stdin/错误脱敏，以及 exit 0 仅生成阻断报告的契约；
- committed provenance 路径排序、offline guard 和 43 文件/10 迁移。

最终验证：

- S17/S18/S19 联合：37/37 通过，其中 S19 4/4；
- candidate/provenance/config 定向：35/35 通过；
- `npm test`：341/341 通过；
- `npm run verify:synthetic-api-preflight`：通过，43 个实现文件/10 个迁移；
- `npm run check`：通过；
- `git diff --check`：通过。

最终三路只读审计未发现剩余 P0/P1。此前 WAL 物理写、path/handle TOCTOU、blocked CLI exit 语义和凭据读取声明问题均已修复并回归。

## 已接受的 P2 / 外部硬门

Node `DatabaseSync` 不能绑定已验证 fd/VFS。若拥有 approved parent 写权限的同账号恶意进程在检查窗口内精确换入自洽数据库、供 SQLite 打开后再换回，仍存在精确 ABA 残余。当前实现通过 held fd、全文件 hash 和事务内多次身份复核降低风险，并固定输出：

```text
approvedParentAclAndSameAccountProcessIsolationExternallyVerified=false
readyForExternalIntegration=false
```

因此该残余不会在本切片形成授权提升。真实 S19 前必须由专用 OS 账号、ACL/所有权与同账号进程隔离关闭；若未来威胁模型要求本地代码独立抵御 hostile same-account writer，应删除 production recovery/S18 binding，或改用可绑定 fd 的 VFS/隔离进程后重新审计。

## 仍未满足的外部与生产硬门

- 获批 authority/coordinator/deployer 协议、trust root、角色身份与生命周期；
- 权威证据/审计正文、可信时间、全局最新 checkpoint 与外部防回滚锚；
- 线性一致全局 reservation/单次消费、reservation 与 durable outbox 同事务；
- operation fingerprint、单调 fence、目标幂等 admission 与 immutable artifact/config/secret version 绑定；
- 平台事件、独立 read-after-write、健康观察、sticky UNKNOWN 对账、独立补偿授权和回滚安全；
- AppID/权限/AppSecret 托管、域名、DNS/TLS、基础设施、法律页面、数据库和 ACL/账号隔离现场核验；
- HarmonyOS HUKS/AssetStore、微信 DevTools 与成人受控设备联网 E2E；
- 正式法律文本、儿童易懂摘要、PIPIA、存量整改、留存/删除、受托方、备案、AppGallery 审核和 RELEASE 签名发布。

生产儿童功能门必须继续关闭。不得部署、侧载到孩子设备、切换成人账号、关闭未成年人模式、开启孩子设备开发者模式或采用其他绕过正式分发的路线。

## 下一步

下一项仍是真实 S19，但必须先由受权外部系统提供并批准协议、trust root、身份体系、可信时间、全局 reservation/outbox 语义、target admission/fencing、独立观察、补偿和回滚契约。获得这些输入前，只能维护 blocker report，不能自行造一个本地“成功 saga”、假外部 receipt 或部署通道。
