# 受控 synthetic 本地授权账本初始化与单次消费记录

> 适用范围：阶段 1 / S17。在独立本地 SQLite 中记录签名 revocation checkpoint 的本 ledger 单调历史，并为一个 S16 签名束提交一次本地使用记录。
>
> 本手册不认证外部权威或真实身份，不提供可信时间、权威最新 checkpoint、跨主机/全局单次消费或真实部署许可。全部输出仍是 `deploymentAuthorization=not_granted`，不得据此联网、部署、开放生产儿童门或让儿童实际使用。

## 1. 准确边界

S17 提供两个 CLI：

```text
npm run init:synthetic-authorization-ledger
npm run consume:synthetic-deployment-grant
```

初始化命令创建一个独立本地账本并记录签名 checkpoint genesis。消费命令在本地排他事务内重跑 S16 verifier，约束本 ledger 已观察 checkpoint 的 sequence 与累计吊销集合，并记录一个本地单次使用 receipt 或可安全重放的稳定 rejection。

成功状态只能解释为：

```text
local-ledger-genesis-recorded
local-ledger-genesis-replayed
local-single-use-record-committed
local-single-use-record-replayed
```

其中 `local-single-use-record-committed` 只表示一个 ledger 文件内已经提交本地使用记录。它不表示 grant 已在权威系统中全局消费，不表示真实部署已发生，也不把 S16 的 `unconsumed` 输出升级成部署许可。

两个命令都不会联网、调用部署器、读生产数据、写 synthetic 业务 SQLite、创建运行 Token secret、修改 production 儿童门或授权儿童使用。

## 2. 执行前硬门

任一项不成立即停止：

- 当前候选已提交，index、工作树中的 39 个受审实现文件和精确 001～010 迁移与 `HEAD` 一致；
- `npm run verify:synthetic-api-preflight` 已通过，并由同一候选配置保存当前 schema 4 artifact；
- S13 数据根、S14 bootstrap、S15 capture/finalize 和 S16 verification document 属于同一候选、配置、物理根与短时 subject；
- S16 信任策略文件及批准父目录仍位于仓库和 synthetic 数据根之外，并由环境摘要精确钉住；
- ledger 专用批准父目录已存在，位于仓库、synthetic 数据根和策略目录之外，不是网络/device 路径、符号链接或 junction；
- ledger ID、consumer ID 和目标环境都是由获批外部流程生成的 64 位小写 SHA-256，不含真实标识明文；
- 全部 production 儿童门、跟踪客户端网络和正式分发继续关闭；
- 操作员理解本地账本没有专用 OS 账号/ACL、外部防回滚锚、可信时间和全局协调证明时，只能作为本地工程边界验证。

测试生成的内存 Ed25519 密钥、合成签名束和 test-only ledger 不能复用为生产路径输入。生产 API 会拒绝 test-only provenance 与生产 ledger 混用。

## 3. 路径、环境与身份绑定

除完整 S12 synthetic 配置和 S16 策略环境外，两个命令还要求：

```text
SYNTHETIC_AUTHORIZATION_LEDGER_FILE=<canonical absolute path>/synthetic-authorization-ledger.sqlite
SYNTHETIC_AUTHORIZATION_LEDGER_APPROVED_PARENT=<exact canonical parent>
SYNTHETIC_AUTHORIZATION_LEDGER_ID_SHA256=<64 lowercase hex>
SYNTHETIC_AUTHORIZATION_CONSUMER_ID_SHA256=<64 lowercase hex>
SYNTHETIC_AUTHORIZATION_TARGET_ENVIRONMENT_SHA256=<64 lowercase hex>
```

运行 profile 必须精确为：

```text
NODE_ENV=production
DEPLOYMENT_TIER=synthetic
```

固定账本文件名是 `synthetic-authorization-ledger.sqlite`，最大 16 MiB。文件必须是批准父目录的直接子文件，与 canonical 仓库在同一本地卷；UNC、device path、dot-segment、混合分隔符、异卷、非普通文件、多链接、任一祖先 symlink/junction 和路径漂移都 fail closed。

genesis 把以下摘要或身份固化到 ledger：

- ledger、consumer 与目标环境；
- 活跃 policy ID、policy 内容摘要和 revision；
- genesis checkpoint sequence 与 envelope 摘要；
- ledger 文件、批准父目录、device/inode；
- platform、architecture、hostname 与 OS 账号上下文。

因此复制、改名、换父目录、换主机/账号或替换文件不能无声复用 ledger。这个本地绑定不替代专用 OS 账号、ACL/所有权、磁盘加密、备份隔离或外部防回滚锚。

## 4. ACK 与 canonical stdin

初始化要求：

```text
SYNTHETIC_AUTHORIZATION_LEDGER_INIT_ACK=initialize-local-ledger-not-authority-v1
```

消费要求：

```text
SYNTHETIC_AUTHORIZATION_CONSUME_ACK=record-local-single-use-not-deployment-v1
```

ACK 不是秘密或部署批准，只表示操作员理解本命令的本地、未授权边界。每个 CLI 除 `--help` 外不接受参数，只从非 TTY stdin 读取一个 UTF-8、最多 768 KiB 的 canonical JSON：

- 必须精确等于 `JSON.stringify` 的单行结果；
- 只允许末尾可选一个 LF；CRLF、缩进、额外空白、重复键、尾随数据或替代编码均拒绝；
- 不得包含 origin、AppID、AppSecret、dataset、数据根、SQLite/策略/ledger 路径或法律声明明文及其 JSON 转义形式；
- 不得用命令行参数、shell history、普通文件、日志、截图或工单中转输入。

初始化顶层字段必须精确为：

```text
schemaVersion=1
purpose=synthetic_local_authorization_ledger_initialize
requestId=synthetic-ledger-init-...
signedRevocationCheckpoint=<S16 checkpoint envelope>
```

消费顶层字段必须精确为：

```text
schemaVersion=1
purpose=synthetic_local_grant_compare_and_consume
requestId=synthetic-grant-consume-...
verificationDocument=<完整 S16 verification 输入文档>
```

`verificationDocument` 是 S16 的原始签名束验证输入，不是先前保存的 S16 stdout。S17 会重新运行 S16 verifier，并只接受当前 schema 2 安全绑定结果；不得手工拼装、删字段或把旧输出当作新输入。

## 5. Genesis 初始化与精确重放

在账本路径完全不存在时执行初始化。成功路径会：

1. 以 `wx` 排他创建普通文件；POSIX 要求权限精确为 `0600`，Windows ACL 仍属于外部硬门；
2. 固定 SQLite `application_id`、ledger schema 1、`journal_mode=DELETE`、`synchronous=FULL`；
3. 在 `BEGIN IMMEDIATE` 内建立精确表、索引和不可变 trigger；
4. 使用 S16 的生产 checkpoint API 读取钉住策略并验证签名 checkpoint；
5. 提交前再次二读策略和验证同一 checkpoint；
6. 原子记录 ledger identity、genesis checkpoint 与观察时间。

精确相同的 request ID、完整输入指纹和 checkpoint 可重放为 `local-ledger-genesis-replayed`；重放仍会重新验证当前策略/checkpoint 及有效期。不同请求、不同输入或不同 checkpoint 不得接管既有账本。提交前确认回滚时可用原请求重试；提交结果无法证明时返回 `SYNTHETIC_AUTHORIZATION_LEDGER_RESULT_UNKNOWN`，必须先用精确原请求恢复，禁止换 request ID 试探。

ledger schema 1 是独立本地账本格式，不是服务端业务迁移 `011`；服务端迁移集合仍精确为 001～010。

## 6. Checkpoint 单调、累计吊销与永久 block

本 ledger 对已观察 checkpoint 执行以下规则：

- 低于当前 sequence：`CHECKPOINT_ROLLBACK`，不推进；
- 高于当前 sequence 超过 1：`CHECKPOINT_GAP`，不推进；
- 与当前 sequence 相同：必须是完全相同的 checkpoint 摘要，否则视为 fork；
- 下一 sequence：必须精确 `+1`，policy ID、内容摘要和 revision 必须与 ledger identity 一致；
- revoked key、principal、approval 和 grant 四类集合只能累计，不得删除任何已观察项。

同 sequence 不同摘要，或新 checkpoint 移除任一累计吊销项，会在 ledger 中提交不可变 block。block 一旦存在，后续新请求均返回 `SYNTHETIC_AUTHORIZATION_LEDGER_BLOCKED`；不得删行、改 trigger、回拨 sequence、替换文件或复制旧 ledger 继续。

若新 checkpoint 有效但随后 S16 bundle 验证、policy/consumer/target 绑定、唯一性或有效期检查失败，checkpoint 仍与稳定 rejection 在同一事务中提交。这样调用方不能通过换请求退回旧 checkpoint；原 request 会恢复同一稳定拒绝。

这些规则只覆盖本 ledger 已观察历史，不证明 checkpoint 是权威最新，也不阻止另一个 ledger、主机或 consumer 回放旧 checkpoint。

## 7. 本地 compare-and-record、幂等与结果未知

新消费在一个 `BEGIN IMMEDIATE` 中完成：

1. 验证 schema、完整性、外键、不可变 trigger、全部 checkpoint/receipt/rejection/block 摘要；
2. 验证 ledger、consumer、target、policy、文件和主机上下文；
3. 在任何 verifier 调用前恢复精确历史 request；
4. 拒绝本机观察时间早于 ledger 已记录最大时间；
5. 验证 checkpoint，重跑完整 S16，并在提交边界再次验证 checkpoint；
6. 推进有效 checkpoint，检查最终有效期和全部绑定；
7. 对新消费原子写入不可变 receipt，或对终态失败/唯一性冲突写入不可变 rejection。

本地唯一约束覆盖：

- grant ID；
- grant envelope；
- approval envelope；
- 同一 target environment、source commit、implementation tree 与 configuration 元组。

相同 request ID 和完全相同输入指纹可恢复历史 receipt 或 rejection；相同 request ID 携带不同输入返回 `IDEMPOTENCY_CONFLICT`。同 grant/approval/候选目标改用新 request ID 不会创建第二条 receipt，而会被稳定拒绝。

历史 receipt replay 会在 verifier 前返回当时已提交结果，不会声称重新核验当前 ledger head、当前外部 approval 或当前 checkpoint；输出中的 `historicalReceiptRecovered=true`、`currentLedgerHeadRevalidatedForThisCall=false` 和 `externalApprovalRevalidatedForNewConsumption=false` 必须保留原意。

提交后崩溃、关闭失败、文件身份无法复核或结果已无法证明时只返回 `RESULT_UNKNOWN`。此时停止其他写入，只能用精确原 request 恢复；禁止换键、改 bundle、删除 sidecar 或直接查询/修改内部表来猜测结果。

## 8. 并发、DELETE journal 与隔离处置

账本使用 `BEGIN IMMEDIATE` 和 15 秒 busy timeout 串行化本地写入。同一 grant 的两个真实 Node 进程竞争时，只允许一个本地 receipt，另一个在获得锁后形成稳定拒绝；同一 request 竞争则形成一次提交和一次精确 replay。

SQLite DELETE journal 可能是合法同行事务的瞬态 sidecar，也可能是进程被终止后留下的 hot journal。对既有 ledger，工具允许 SQLite 在可写排他入口内先完成恢复，再验证完整 schema、记录摘要和文件身份；不得因为加锁前看见 `-journal` 就删除文件或误判为永久损坏。

以下边界不同：

- 全新 ledger 路径初始化前出现任何 `-journal`、`-wal` 或 `-shm`：路径不安全，停止；
- 既有 ledger 出现 `-wal` 或 `-shm`：该 profile 不允许，fail closed；
- DELETE journal 经 SQLite 恢复后仍无法关闭、账本超 16 MiB、identity/context 漂移或完整性失败：隔离 ledger 和父目录，禁止人工修表或删行。

外部处置至少应保存脱敏错误码、候选 commit、Node.js 版本和时间线；不得保存输入、签名正文、真实资源身份、路径或秘密。是否恢复备份、重建 ledger 或轮换策略必须由 S18 的权威流程决定，S17 不自动删除或接管未知状态。

## 9. 成功输出与始终未授权

初始化和消费成功 stdout 都是一行脱敏 schema 1 JSON。它可以包含 digest、sequence、revision、source commit、观察时间和 receipt 摘要，但不回显路径、策略正文、公钥、签名、原始 request/grant/approval ID、origin、AppID、AppSecret、dataset 或数据库内容。

所有结果必须继续包含：

```text
deploymentAuthorization=not_granted
productionChildGateState=not_observed
childUseAuthorization=not_granted
operations.deploymentPerformed=false
operations.syntheticDatabaseWritten=false
operations.networkAccessPerformed=false
```

初始化结果还必须正确解释：

```text
trustPolicyExternallyAuthorizedByThisCommand=false
trustedTimeVerified=false
latestCheckpointExternallyConfirmed=false
rollbackResistanceExternallyAnchored=false
consumerIdentityExternallyAuthenticatedByThisCommand=false
deploymentActionAtomicallyBound=false
```

消费或历史 receipt replay 结果还必须正确解释：

```text
trustPolicyExternallyAuthorizedByThisCommand=false
trustedTimeVerified=false
latestCheckpointExternallyConfirmed=false
rollbackResistanceExternallyAnchored=false
consumerIdentityExternallyAuthenticatedByThisCommand=false
externalDeploymentAtomicityVerified=false
globalConsumptionVerified=false
```

失败 stdout 为空，stderr 只输出一行稳定错误码和固定前缀，不复制内部异常、输入或路径。

## 10. 稳定错误与处置域

- `..._ARGUMENT_INVALID`、`..._ACK_REQUIRED`、`..._STDIN_REQUIRED`、`..._INPUT_TOO_LARGE`、`..._INPUT_INVALID`、`..._SENSITIVE_INPUT`：修正受控输入通道，不要改写旧结果；
- `..._PRODUCTION_RESOURCE_REJECTED`、`..._ROOT_UNAVAILABLE`、`..._ROOT_UNSAFE`、`..._REQUIRED`、`..._CONTEXT_MISMATCH`：停止并复核 profile、独立路径、文件和主机上下文；
- `..._ALREADY_INITIALIZED`、`..._TEST_ONLY_STATE_REJECTED`、`..._POLICY_ROTATION_REQUIRED`：不得接管、洗掉 test provenance 或直接替换策略；
- `..._SCHEMA_INVALID`、`..._INTEGRITY_INVALID`、`..._BLOCKED`：隔离 ledger，不得修表、删 trigger、VACUUM 或复制旧文件继续；
- `..._CHECKPOINT_ROLLBACK`、`..._CHECKPOINT_GAP`：回到权威 checkpoint 流程，不得降级或跳号；
- `..._CHECKPOINT_FORK`、`..._CHECKPOINT_REVOCATION_REMOVED`：ledger 已永久 block，进入权威安全调查；
- `..._POLICY_MISMATCH`、`..._CONSUMER_MISMATCH`、`..._TARGET_MISMATCH`：bundle 与 ledger identity 不一致，禁止拼接；
- `..._GRANT_ALREADY_CONSUMED`、`..._APPROVAL_ALREADY_CONSUMED`、`..._TARGET_ALREADY_CONSUMED`、`..._IDEMPOTENCY_CONFLICT`：恢复原 request 或停止，不得换键绕过；
- `..._LOCAL_CLOCK_ROLLBACK`、`..._AUTHORIZATION_EXPIRED`：本机时间或有效期不足，停止；本地改钟不能形成可信时间；
- `..._BUSY`、`..._TRANSACTION_FAILED`：只有工具明确证明未提交时才可用原请求重试；
- `..._RESULT_UNKNOWN`：停止并用精确原请求恢复；
- `..._VERIFICATION_FAILED` 或下层 `SYNTHETIC_EXTERNAL_APPROVAL_...`：保持全部门关闭，回到 S16/权威签名流程。

任何失败都不得通过回拨时间、改摘要、移除吊销项、换 request ID、删除 sidecar、复制 ledger、关闭域名/TLS 校验或修改数据库来绕过。

## 11. S18 外部与生产硬门

S17 没有关闭以下事项：

1. 信任策略发布者的权威认证、受控置入、ACL/所有权、轮换和审计；
2. declarant、verifier、approver、issuer、revocation authority 与 consumer 的真实身份和角色生命周期；
3. 19 项权威证据正文、来源、法律记录和不可变审计记录的真实取回；
4. 可信时间和 checkpoint 为权威全局最新的确认；
5. 跨 ledger、主机和 consumer 的 sequence、防回滚、并发吊销与 grant 全局单次消费；
6. ledger 的专用 OS 账号、ACL/所有权、加密、备份和外部防回滚锚；
7. 最终撤销判断、真实部署动作、消费状态与部署回执的外部原子协调或安全补偿；
8. 部署监控、失败补偿、回滚、成人受控设备 E2E、HUKS/AssetStore 与 DevTools smoke；
9. AppID/权限/AppSecret、域名、DNS/TLS、基础设施、法律页面和数据库隔离的真实核验；
10. 正式法律文本、儿童易懂摘要、PIPIA、存量整改、逐类留存/删除、受托方约束、备案、AppGallery 审核与正式签名发布。

只有 S18/获批外部系统把这些工程硬门真实关闭后，才可另行批准一次受控 synthetic 部署。仍只允许合成家庭、模拟器或成人受控设备；不得侧载到孩子设备、切换成人账号、关闭未成年人模式、开启孩子设备开发者模式或采用其他绕过正式分发的路线。正式合规与发布硬门全部关闭前，production 儿童功能门必须继续保持关闭。
