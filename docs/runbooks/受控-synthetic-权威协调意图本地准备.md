# 受控 synthetic 权威协调意图本地准备

> 本手册只描述 S18 的本地请求意图准备。它不向外部权威提交请求，不认证策略或真实身份，不提供可信时间、权威最新 checkpoint、跨主机全局消费或部署回执，也不执行部署。所有成功输出仍为 `deploymentAuthorization=not_granted`、`productionChildGateState=not_observed`、`childUseAuthorization=not_granted`。

## 1. 能力边界

S18 新增：

```text
npm run prepare:synthetic-authority-coordination-intent
```

命令只完成三件事：

1. 通过只读 S17 API 恢复一个已经存在且精确匹配的本地消费回执；
2. 把回执、原消费请求和候选安全绑定压缩为摘要；
3. 在独立本地 SQLite journal 中原子记录 `locally_prepared_unsubmitted` 意图。

命令没有 HTTP、TLS、DNS、子进程或部署适配器路径。S17 回执只作为历史本地事实，不会被升级为当前授权、外部提交、全局消费或部署事实。

## 2. 前置条件

- 只允许 `NODE_ENV=production` 与 `DEPLOYMENT_TIER=synthetic`；
- S17 ledger 必须已经初始化，且精确原消费请求已经形成历史 consumption；
- 继续提供 S17 的完整环境绑定与消费确认：

```text
SYNTHETIC_AUTHORIZATION_CONSUME_ACK=record-local-single-use-not-deployment-v1
SYNTHETIC_AUTHORIZATION_LEDGER_FILE=<固定 S17 ledger 绝对路径>
SYNTHETIC_AUTHORIZATION_LEDGER_APPROVED_PARENT=<S17 ledger 直接父目录>
SYNTHETIC_AUTHORIZATION_LEDGER_ID_SHA256=<非平凡小写 SHA-256>
SYNTHETIC_AUTHORIZATION_CONSUMER_ID_SHA256=<非平凡小写 SHA-256>
SYNTHETIC_AUTHORIZATION_TARGET_ENVIRONMENT_SHA256=<非平凡小写 SHA-256>
```

- S16 策略文件、批准父目录、synthetic 数据根及其环境摘要绑定仍必须完整；
- 新 journal 使用独立批准父目录：

```text
SYNTHETIC_AUTHORITY_COORDINATION_INTENT_ACK=prepare-local-intent-not-submitted-v1
SYNTHETIC_AUTHORITY_COORDINATION_INTENT_JOURNAL_FILE=<批准父目录>/synthetic-authority-coordination-intent.sqlite
SYNTHETIC_AUTHORITY_COORDINATION_INTENT_APPROVED_PARENT=<独立批准父目录>
SYNTHETIC_AUTHORITY_COORDINATION_INTENT_JOURNAL_ID_SHA256=<非平凡小写 SHA-256>
```

journal 父目录必须是 canonical 仓库、synthetic 数据根、策略目录和 S17 ledger 目录之外的真实本地目录，并与仓库位于同一本地卷。UNC/device、dot-segment、混合分隔符、任一祖先 symlink/junction、非普通文件、硬链接、目录交叠或跨卷路径均拒绝。journal 最大 16 MiB。

## 3. 输入

CLI 除 `--help` 外不接受参数，只从非 TTY stdin 读取最多 1 MiB 的单行 canonical JSON：

```json
{
  "schemaVersion": 1,
  "purpose": "synthetic_authority_coordination_intent_prepare",
  "requestId": "synthetic-authority-intent-example0000000000000001",
  "authorizationConsumptionDocument": {
    "schemaVersion": 1,
    "purpose": "synthetic_local_grant_compare_and_consume",
    "requestId": "synthetic-grant-consume-example00000000000001",
    "verificationDocument": {}
  }
}
```

`authorizationConsumptionDocument` 必须是形成 S17 历史记录的精确原文。不得自行添加 `receiptSha256`、`submitted`、`authorized` 或任何外部响应字段。输入、环境和日志不得含真实手机号、真实设备标识、AppSecret、私钥、证书、签名材料或生产资源身份。

## 4. 执行与恢复顺序

### journal 尚不存在

1. 先以 `{ readOnly: true }`、`query_only` 和普通读事务完整核验 S17 schema、context、record digest 和精确历史 request；
2. 历史 consumption 不存在、命中历史 rejection、S17 正在写入或完整性不明时，绝不创建 journal；
3. 只有历史 receipt 已恢复且规范化成功，才以 `wx` 排他创建固定 journal；
4. 在 `BEGIN IMMEDIATE` 内建立 schema/identity、写入一条摘要 intent、全量复核后提交。

### journal 已存在

1. SQLite 可在可写排他入口中恢复该 journal 自己的安全 DELETE rollback journal；
2. 完整核验 schema、不可变 trigger、identity 和全部 intent 摘要；
3. 精确 S18 request replay 在重新读取 S17 前恢复历史 intent；
4. 新 request 才只读恢复 S17 receipt 并执行本 journal 内唯一性检查。

S17 的任一 `-journal` 条目都会使只读恢复返回 `SYNTHETIC_AUTHORIZATION_LEDGER_BUSY`；它不会删除或恢复 S17 journal。S17 `-wal/-shm` 始终 fail closed。S18 只允许自己安全、普通、单链接的 DELETE journal 由 SQLite 恢复；S18 `-wal/-shm` 或未知 sidecar 始终拒绝。

### 给 S19-readiness 使用的历史 intent 只读恢复

S19-readiness 只调用：

```text
recoverSyntheticAuthorityCoordinationIntent(environment, document)
```

该入口仅恢复精确历史 S18 intent。它使用 `{ readOnly: true }`、`query_only=ON`、`temp_store=MEMORY` 和普通 `BEGIN`，不调用 S17、不重新消费、不重判当前授权或本机时间，也不创建或更新任何行。成功固定为 `outcome=replayed`、`localIntentJournalOpenedReadOnly=true`、`localIntentJournalOpenedWritable=false`、`coordinationIntentRowInserted=false`。

只读入口在 DatabaseSync 打开前持有 `O_RDONLY` fd，检查 SQLite header 必须为 DELETE 模式并计算全文件 SHA-256；事务期间重复核对 pathname、realpath、文件身份和摘要。`-journal` 返回 BUSY，`-wal/-shm` 或没有 sidecar 但 header 持久为 WAL 的数据库在开库前 fail closed，目录保持零变化。只读入口不会恢复 hot journal；只有原 S18 可写入口可以在既有安全边界内恢复自己的 DELETE journal。

## 5. 本地状态与幂等

唯一持久状态是：

```text
authorityCoordinationStatus=locally_prepared_unsubmitted
result=locally_prepared_unsubmitted
```

- 同 request ID、同 canonical 指纹：返回同一 intent，`outcome=replayed`；
- 同 request ID、不同指纹：`SYNTHETIC_AUTHORITY_COORDINATION_INTENT_IDEMPOTENCY_CONFLICT`；
- 同 receipt、grant、grant envelope、approval envelope 或 target/source/tree/config 元组的新 request：返回相应稳定冲突；
- commit 前失败：完整回滚；
- commit 后结果无法证明：`SYNTHETIC_AUTHORITY_COORDINATION_INTENT_RESULT_UNKNOWN`，只能用精确原请求恢复；
- 不得因超时、未知结果或失败自动生成新 request ID。

journal identity 不绑定单一 S17 ledger，因而一个 journal 可在本地对多个 ledger 做摘要级冲突检测；这种唯一性只存在于该 journal 文件内。复制、删除、回滚或新建另一 journal 都不受外部锚保护，绝不等于跨主机或全局消费。

## 6. 输出解释

首次插入与历史 replay 均只输出摘要和非敏感元数据，不保存或回显原 request、签名束、策略正文、证据正文、绝对路径或凭据。

关键字段必须按以下语义理解：

- `checks.historicalLocalAuthorizationReceiptBoundAtPreparation=true`：准备时绑定过历史 S17 receipt；
- `checks.rawAuthorizationMaterialExcluded=true`：journal 不保存原始授权材料；
- `checks.journalIdentityBoundToSingleLedger=false`；
- `checks.crossLedgerUniquenessOnlyWithinThisJournal=true`；
- `checks.localClockMonotonicWithinThisJournal=true`：新记录的本机观察时间没有倒退；这不是可信时间；
- `checks.externalRollbackAnchorVerified=false`；
- `checks.trustedTimeVerified=false`；
- `checks.latestCheckpointExternallyConfirmed=false`；
- `checks.globalConsumptionVerified=false`；
- `checks.externalAuthorityReceiptVerified=false`；
- `checks.deploymentReceiptVerified=false`；
- `operations.coordinationIntentRowInserted` 只表示本次是否插入新 intent；
- `operations.localIntentJournalOpenedWritable=true` 明示 SQLite 可能执行本 journal 的 rollback recovery；
- `operations.s17AuthorizationLedgerWritten=false`；
- `operations.networkAccessPerformed=false`；
- `operations.externalSubmissionPerformed=false`；
- `operations.deploymentPerformed=false`。

不得把 `outcome=prepared` 解释为外部请求已提交、grant 已保留、全局已消费、目标已变更或服务已健康。

## 7. 常见失败与处置

| 错误 | 含义与处置 |
| --- | --- |
| `...ACK_REQUIRED` | 缺少逐字确认；停止，不降低确认文本 |
| `...INPUT_INVALID` | 非 canonical、字段多缺或 purpose/request ID 不匹配；修正原请求，不添加旁路字段 |
| `SYNTHETIC_AUTHORIZATION_LEDGER_HISTORICAL_RECEIPT_REQUIRED` | S17 没有精确历史 consumption；不得让 S18 隐式消费 |
| `SYNTHETIC_AUTHORITY_COORDINATION_INTENT_HISTORICAL_INTENT_REQUIRED` | S18 没有精确历史 intent；不得创建新 intent 冒充历史 |
| `SYNTHETIC_AUTHORIZATION_LEDGER_BUSY` | S17 正在写入或留有 DELETE journal；稍后用精确原请求重试，不手删 journal |
| `...LOCAL_CLOCK_ROLLBACK` | 本机观察时间早于 receipt 或 journal 高水位；停止并调查主机时钟/快照，不能靠改钟形成可信时间 |
| `...IDEMPOTENCY_CONFLICT` | 同 request ID 对应不同内容；隔离调查，禁止换键掩盖 |
| `...ALREADY_PREPARED` | 本 journal 已绑定同一安全对象；保留原记录，不建立第二 intent |
| `...SCHEMA_INVALID` / `...INTEGRITY_INVALID` / `...CONTEXT_MISMATCH` | journal 形态、记录或路径身份不可信；隔离文件，不自动修复或接管 |
| `...BUSY` | S18 journal 锁竞争；稍后重试精确原请求 |
| `...RESULT_UNKNOWN` | 无法证明提交或清理结果；保留现场，只能精确原请求恢复 |

不得手工删除、重命名、复制、截断或修复 journal/sidecar，不得把未知状态恢复为“未使用”。需要重建时应保留原文件和脱敏时间线，由后续获批权威流程处置。

## 8. 仍未满足的硬门

S18 本地切片没有关闭以下硬门：

- 获批 trust root、策略发布权威、轮换和外部审计；
- declarant、verifier、approver、issuer、revocation authority、consumer 和 executor 的真实身份及角色生命周期；
- 19 项权威证据正文与审计记录的真实取回；
- 可信当前时间与权威全局最新 checkpoint；
- 跨 journal、主机、consumer 和区域的全局 CAS、防回滚与单次消费；
- 目标平台 admission/fencing、不可变 artifact/config 绑定、真实变更事件、独立状态观察与健康验证；
- 结果未知、失败补偿和回滚的外部 saga；
- 独立 AppID/权限/AppSecret、域名、DNS/TLS、基础设施、法律页面和数据隔离现场核验；
- 成人受控设备网络 E2E，以及正式法律文本、PIPIA、存量整改、备案和 AppGallery 正式发布。

这些事实只能由获批外部系统和现场证据建立。生产儿童功能门必须继续关闭；不得部署、侧载、切换成人账号、关闭未成年人模式、开启孩子设备开发者模式或采用其他绕过正式分发的路线。

## 9. S19-readiness 交接

`npm run report:synthetic-external-saga-blockers` 只通过上述 read-only API 绑定 S18，不直接读取或裁决 S17。它生成固定 blocked、非权威、非穷尽的最小已知 blocker report；不会创建 operation、reservation、outbox、fence、部署或补偿状态。退出码 0 只表示报告生成成功，不表示 readiness 通过。完整契约见 [受控 synthetic 外部 saga 阻断报告](受控-synthetic-外部saga阻断报告.md)。
