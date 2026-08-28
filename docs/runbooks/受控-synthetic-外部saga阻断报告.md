# 受控 synthetic 外部 saga 阻断报告

> 本手册描述 S19-readiness 的本地只读 blocker report。它不是外部集成、部署前验收或部署许可；真实 S19 尚未开始。成功输出永远是 `external_integration_blocked`，全部部署与儿童使用授权保持关闭。

## 1. 能力边界

命令：

```text
npm run report:synthetic-external-saga-blockers
```

它只完成以下动作：

1. 只读恢复一个精确存在的历史 S18 coordination intent；
2. 从 S18 输出中保留非敏感摘要绑定；
3. 输出一份固定、机器可读的最小已知阻断目录和协议能力目录。

它不会创建或更新 SQLite、journal、operation ID、reservation、outbox、fence、部署回执或补偿状态；不会读取凭据值、联网、提交外部请求、调用部署器、部署、补偿、回滚、读取生产数据或修改儿童功能门。

## 2. 前置环境

只允许：

```text
NODE_ENV=production
DEPLOYMENT_TIER=synthetic
SYNTHETIC_EXTERNAL_SAGA_READINESS_ACK=report-blockers-no-external-action-v1
```

还必须提供 S18 只读恢复所需的精确历史环境绑定，包括：

```text
SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ACK=prepare-local-intent-not-submitted-v1
SYNTHETIC_AUTHORITY_COORDINATION_INTENT_JOURNAL_FILE=<既有 S18 journal 绝对路径>
SYNTHETIC_AUTHORITY_COORDINATION_INTENT_APPROVED_PARENT=<该 journal 的批准直接父目录>
SYNTHETIC_AUTHORITY_COORDINATION_INTENT_JOURNAL_ID_SHA256=<原 journal ID 摘要>
SYNTHETIC_DATA_ROOT=<原 synthetic 数据根>
SYNTHETIC_APPROVAL_TRUST_POLICY_APPROVED_PARENT=<原策略批准父目录>
SYNTHETIC_APPROVAL_TRUST_POLICY_FILE=<原公开策略文件>
SYNTHETIC_AUTHORIZATION_LEDGER_APPROVED_PARENT=<原 S17 ledger 批准父目录>
SYNTHETIC_AUTHORIZATION_LEDGER_FILE=<原 S17 ledger 文件>
```

环境必须完全不含 `WX_APPSECRET` 键。键存在时，命令在 S18 recovery 前返回 `SYNTHETIC_EXTERNAL_SAGA_READINESS_PRODUCTION_RESOURCE_REJECTED`，且不会读取该值。不得为了运行报告而导入其他私钥、Token、证书、签名材料、endpoint 或生产身份。

## 3. 输入

CLI 除 `--help` 外不接受参数，只从非 TTY stdin 读取最多 1 MiB 的单行 canonical JSON：

```json
{"schemaVersion":1,"purpose":"synthetic_s19_external_integration_blocker_report","authorityCoordinationIntentDocument":{"schemaVersion":1,"purpose":"synthetic_authority_coordination_intent_prepare","requestId":"synthetic-authority-intent-example0000000000000001","authorizationConsumptionDocument":{}}}
```

`authorityCoordinationIntentDocument` 必须是创建历史 S18 intent 时的精确原文；示例中的空对象不能直接执行。顶层和 S18 文档均采用 exact-key 校验，调用方不能添加 endpoint、credential、trust root、authority response、receipt、`verified=true`、`readyForExternalIntegration=true` 或其他外部事实。

命令会在内存中读取完整 S18 document 以计算并恢复精确历史绑定，其中可能包含 S17 verification/signed envelope；它不会持久化输入，也不会在报告中回显这些材料。`checks.rawAuthorizationMaterialExcludedFromReport=true` 只描述报告输出，不表示 stdin 没有原授权材料。

## 4. S18 只读恢复

恢复 API 为：

```text
recoverSyntheticAuthorityCoordinationIntent(environment, document)
```

固定行为：

- 使用 `{ readOnly: true }`、`query_only=ON`、`temp_store=MEMORY` 和普通 `BEGIN`；
- 不调用 S17、不重新消费 grant、不重新验证当前外部批准或本机时间；
- 只接受精确历史 request；缺失返回 `SYNTHETIC_AUTHORITY_COORDINATION_INTENT_HISTORICAL_INTENT_REQUIRED`，同 request 异指纹返回幂等冲突；
- 在 SQLite 打开前用持有的只读 fd 检查普通单链接文件、SQLite header、DELETE journal mode 和全文件 SHA-256；事务期间重复核对 path、realpath、文件身份和摘要；
- `-journal` 返回 BUSY，`-wal/-shm` 或持久 WAL header 返回 RESULT_UNKNOWN/SCHEMA_INVALID，并保持目录零变化；只读入口不恢复 hot journal；
- 成功固定 `outcome=replayed`、`historicalIntentRecovered=true`、`localIntentJournalOpenedReadOnly=true`、`localIntentJournalOpenedWritable=false`、`coordinationIntentRowInserted=false`。

Node `DatabaseSync` 不能绑定已打开 fd/VFS，因此“有权写 approved parent 的同账号恶意进程在检查窗口内精确换入并换回文件”仍是 P2 外部硬门。报告固定保留 `approvedParentAclAndSameAccountProcessIsolationExternallyVerified=false`；在专用 OS 账号、ACL/所有权与同账号进程隔离得到外部证明前，不得把该恢复用于正向授权。

## 5. 输出解释

成功 stdout 是一行 JSON，关键字段固定为：

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

报告当前列出 17 个 blocker 和 14 个 required capability。数组、顺序和摘要只锁定这个版本的本地目录内容；它们不是签名、权威观察、完整部署检查表或批准。即使未来某一项被外部关闭，本命令也不接受调用方正向声明，仍只会生成阻断报告。

所有正向外部事实保持 false，包括协议批准、trust root、真实角色认证、可信时间、最新 checkpoint、全局 reservation/消费、durable outbox 原子性、target admission/fencing、不可变部署绑定、外部提交/回执、独立平台状态/健康观察、补偿授权和回滚安全。

操作字段固定声明：S18 journal 只读打开；S18 journal、synthetic 数据库和本地 readiness 状态均未写；credential value 未读取；网络、提交、reservation、部署、补偿、生产数据读取和儿童门变更均未发生。

## 6. 退出码与稳定失败

`--help` 和成功生成阻断报告都返回 0。退出码 0 只表示报告成功生成，绝不表示 ready、approved、submitted 或 deployed。任何把该 npm script 当成 CI readiness pass/fail 门的调用都是错误用法。

常见稳定错误：

| 错误 | 处置 |
| --- | --- |
| `...ARGUMENT_INVALID` / `...ACK_REQUIRED` | 修正调用和逐字确认，不降低确认文本 |
| `...STDIN_REQUIRED` / `...INPUT_TOO_LARGE` / `...INPUT_INVALID` | 使用非 TTY、1 MiB 内的单行 canonical 原文 |
| `...SENSITIVE_INPUT` | 输入含环境路径或其他受保护值；停止并重建脱敏通道 |
| `...PRODUCTION_RESOURCE_REJECTED` | profile 不符或环境存在 `WX_APPSECRET`；移除秘密环境，不读取或复制其值 |
| `...S18_SOURCE_INVALID` | S18 输出形状/语义不可信；隔离，不把异常转成 readiness |
| `SYNTHETIC_AUTHORITY_COORDINATION_INTENT_HISTORICAL_INTENT_REQUIRED` | 没有精确历史 S18 intent；不得创建新 intent 或改请求冒充历史 |
| S18 `...BUSY` / `...RESULT_UNKNOWN` / `...SCHEMA_INVALID` / `...CONTEXT_MISMATCH` | 保留现场，禁止手删 sidecar、修库、复制或换键绕过 |

## 7. 真实 S19 仍需关闭的硬门

报告中的 17/14 目录只是下列外部工作的最小子集：

- 获批 authority/coordinator/deployer 协议、权威 trust root、角色身份与生命周期；
- 权威证据/审计正文取回、可信时间与权威全局最新 checkpoint；
- 线性一致全局 reservation 与单次消费、reservation 和 durable outbox 同事务；
- 不可变 operation fingerprint、单调 fence、目标幂等 admission；
- artifact/build/config/secret version 与真实目标资源不可变绑定；
- 平台变更事件、独立 read-after-write 和健康观察、sticky UNKNOWN 对账；
- 独立补偿授权、回滚安全与外部防回滚锚；
- AppID/权限/AppSecret 托管、域名、DNS/TLS、基础设施、法律页面、数据库与 ACL/账号隔离现场证明；
- 正式法律文本、PIPIA、存量数据整改、留存/删除、备案、AppGallery 审核和 RELEASE 发布。

S16 `unconsumed`、S17 local receipt、S18 `locally_prepared_unsubmitted` 和本报告都不是部署许可。生产儿童功能门必须继续关闭；不得部署、侧载到孩子设备、切换成人账号、关闭未成年人模式、开启孩子设备开发者模式或采用其他绕过正式分发的路线。
