# 受控 synthetic 外部签名束离线验证与未消费授权

> 适用范围：阶段 1 / S16。对同一 S15 候选的外部门核验记录、独立审批和一次性部署 grant 做本地、只读、fail-closed 的 Ed25519 验证。
>
> 本命令只确认签名束在“调用方提供并由环境摘要钉住的公开策略”下有效。它不认证策略发布者，不取回身份、证据正文或审计记录，不信任本机时间，不持久化防重放或消费状态，不部署，也不授权儿童使用。

## 1. 准确边界

S16 新增：

```text
npm run verify:synthetic-external-approval
```

成功结果精确表示：

```text
result=signed-bundle-valid-against-provided-policy-unconsumed
deploymentGrantStatus=signature_valid_against_provided_policy_unconsumed
deploymentAuthorization=not_granted
productionChildGateState=not_observed
childUseAuthorization=not_granted
```

“valid”只覆盖当前命令实际完成的结构、摘要、Ed25519 签名、角色、职责隔离、目标、时效和吊销列表检查。“unconsumed”表示本命令没有消费 grant，也没有证明其他系统尚未消费它。任何部署器都不得把 stdout 直接当作可执行许可。

本命令会用当前已提交 provenance 完整重跑 S15：先按原 `finalizedAt` 精确重构历史输出，再以本次验证开始时间重算当前机器状态。生产 CLI 不提供时间、provenance 或 finalizer 覆盖入口；测试替身只能经显式 test-only API 使用，且输出会把当前机器、Git 和数据库重验声明保守标为 `false`。

当前成功输出为 `schemaVersion=2`，在既有结果上增加 `trustPolicyIdSha256`、`consumerIdSha256`、`targetEnvironmentSha256`、`sourceCommit`、`implementationTreeSha256`、`configurationSha256`、checkpoint、approval 与 grant 等安全摘要绑定，供 S17 独立本地账本精确消费。支持层另提供生产 API `verifySyntheticRevocationCheckpoint`：它沿用相同策略摘要钉住和二读规则，只验证一个签名 checkpoint 并返回 schema 1 冻结摘要；这不是新增部署 CLI，也不证明策略权威、可信时间或 checkpoint 为权威最新。

## 2. 执行前硬门

任一项不成立即停止：

- 候选实现已提交，index 与工作树中的 39 个受审实现文件和 001～010 迁移精确匹配 `HEAD`；
- `npm run verify:synthetic-api-preflight` 已通过，并由同一配置生成并保存当前 schema 4 S12 artifact；
- S13 全新根、S14 bootstrap 和 S15 capture/finalize 来自同一候选，数据库仍为 pristine 最小状态且 S15 未过期；
- 外部系统已经真实完成身份认证、权威证据取回和事实核验，并生成独立签名记录；本地人员不得自行伪造“外部”结果；
- 公开信任策略由获批通道独立置入，不在仓库、synthetic 数据根、普通下载目录、工单附件或业务输入中；私钥永不进入本仓库、stdin、环境变量或本机临时夹具；
- 策略摘要、策略文件和批准父目录来自同一个受控操作上下文；任何不确定、残根、跨环境复制、旧 checkpoint 或时间不足均停止；
- 全部 production 儿童门、跟踪客户端网络和正式分发继续关闭。

S16 仓库测试只生成内存 Ed25519 密钥、合成家庭和系统临时 SQLite。它们不是可复用的外部信任材料。

## 3. ACK、stdin 与敏感输入

必须逐字设置：

```text
SYNTHETIC_EXTERNAL_APPROVAL_ACK=verify-signatures-only-not-deployment-v1
```

CLI 除 `--help` 外不接受参数，只从非 TTY stdin 读取一个 UTF-8、最多 512 KiB 的单行 JSON 文档：

- 必须精确等于 `JSON.stringify` 结果，只允许末尾可选的一个 LF；
- CRLF、缩进、额外空白、替代编码、尾随内容或未知字段均 fail closed；
- 输入不得包含当前 origin、AppID、AppSecret、dataset、数据根、SQLite 路径、法律 URL/版本、策略路径或其 JSON 转义形式；
- 输入不得携带公钥、私钥、证书、策略正文或替代信任根；所有签名只按独立策略文件中的公钥验证；
- 不得经命令行、普通文件、shell history、日志、截图或工单中转私钥或业务凭据。

成功只向 stdout 写一行脱敏 JSON；失败 stdout 为空，stderr 只写一行稳定错误码。

## 4. 公开信任策略文件

必须显式提供：

```text
SYNTHETIC_APPROVAL_TRUST_POLICY_APPROVED_PARENT=<受控本地绝对目录>
SYNTHETIC_APPROVAL_TRUST_POLICY_FILE=<该目录直接子文件 trust-policy.json>
SYNTHETIC_APPROVAL_TRUST_POLICY_SHA256=<文件原始字节的小写 SHA-256>
```

路径和文件要求：

- 文件与父目录必须是无 `.`/`..`、无混合分隔符的 canonical 绝对路径，文件必须是批准父目录的直接子项；
- 必须与 canonical 仓库位于同一本地卷，但在仓库和 synthetic 数据根之外；UNC、device namespace、异卷和映射网络卷不在本地信任边界内；
- 从卷根到文件的任一已有路径段都不能是 symlink、junction 或 reparse alias；文件必须是普通单链接文件，最大 128 KiB；
- POSIX 下文件不能 group/world writable；Windows ACL、卷类型、同权限瞬态替换与本地卷证明仍由外部主机门负责；
- 工具在验证前后分别打开并读取策略，比较真实路径、设备/inode、大小、模式、链接数、mtime/ctime、原始摘要和 parsed 内容；任何漂移都拒绝；
- 文件正文必须是无 BOM、无换行、无额外空白的单行 `JSON.stringify` 结果。

策略顶层字段精确为：

```text
schemaVersion, purpose, policyIdSha256, revision,
issuedAt, validFrom, validUntil, keys
```

其中 `purpose=synthetic_external_approval_trust_policy`，策略最长 31 天。每个 key 字段精确为：

```text
keyId, principalIdSha256, role, allowedGateIds,
publicKeySpkiDerBase64url, notBefore, notAfter, status
```

固定规则：

- 算法只能是 Ed25519；公钥必须是 canonical 44 字节 SPKI DER 的无 padding base64url；`keyId` 必须等于 DER 的 SHA-256；
- key 状态只能是 `active`，时效必须落在策略时效内；
- 至少覆盖四个互斥角色：`external_gate_verifier`、`deployment_approver`、`deployment_grant_issuer`、`revocation_authority`；
- 同一 `principalIdSha256` 不能跨策略角色；只有 gate verifier 可以声明 `allowedGateIds`，且 19 项 gate 必须完整覆盖；
- 策略文件只含公钥。任何私钥、密码、证书链或真实身份正文出现时立即停止。

本命令只能证明文件与环境提供的摘要一致，不能证明该摘要由哪个权威方置入，也不能完成策略轮换、撤销或责任人身份认证。

## 5. 签名信封与输入结构

输入顶层字段必须精确为：

```text
schemaVersion, purpose,
s15FinalizeInput, s15FinalizedEvidence,
signedRevocationCheckpoint, signedGateVerifications,
signedDeploymentApproval, signedDeploymentGrant
```

`purpose=synthetic_external_approval_verify`。每个签名信封字段精确为：

```text
keyId, algorithm, payload, signatureBase64url
```

`algorithm` 只能为 `Ed25519`；签名是对应 domain、一个 NUL 字节和按键名排序的 canonical payload JSON 的组合：

```text
UTF8(domain + "\0") || UTF8(canonicalJson(payload))
```

四个 domain 不可混用：

```text
tangguan.synthetic.external-gate-verification.v1
tangguan.synthetic.external-deployment-approval.v1
tangguan.synthetic.external-deployment-grant.v1
tangguan.synthetic.external-revocation-checkpoint.v1
```

### 5.1 吊销 checkpoint

`signedRevocationCheckpoint.payload` 精确包含：

```text
schemaVersion, purpose, policySha256, sequence, issuedAt, validUntil,
revokedKeyIds, revokedPrincipalIdsSha256,
revokedApprovalIdsSha256, revokedGrantIdsSha256
```

它必须由 `revocation_authority` 签名，最长 24 小时，不得来自未来，且 `issuedAt` 不早于本 bundle 中最新 gate verification、approval 或 grant 的签发时间。四类吊销列表必须是严格递增、无重复的小写 SHA-256。checkpoint 不能自撤销其签发 key/principal。

独立 checkpoint 允许在不改写稳定 policy 摘要的前提下吊销既有 key、principal、approval 或 grant；但本命令不查询权威系统，也不持久化最大 sequence，因此明确输出 `revocationCheckpointMonotonicityExternallyVerified=false`。防止旧 sequence 回滚仍是外部门。

### 5.2 19 项 gate verification

`signedGateVerifications` 必须按 S15 的固定 gate 顺序精确包含 19 项。每项同时绑定：

- policy、S15 finalized evidence、subject、candidate、machine state 和 attestation set；
- 当前 source/config/root 派生的 target environment；
- gate ID、声明角色、来源类型和 S15 原证据引用；
- 独立 evidence content、authority record 和 verification record 摘要；
- 声明人与核验人 principal、观察/核验/到期时间；
- `identityStatus=authenticated_by_external_authority`；
- `evidenceStatus=retrieved_and_verified_by_external_connector`；
- `factStatus=verified_satisfied`。

verification record 摘要不能重复；declarant、verifier 和 revocation authority 必须职责隔离。签名与字段一致仍不足以证明外部正文真实存在，本命令不会取回这些摘要所指内容。

### 5.3 独立审批与短时 grant

approval 必须由 `deployment_approver` 签名，发生在全部 gate verification 之后，最长 15 分钟，只允许：

```text
decision=approved
scope=single_synthetic_api_deployment
productionChildGateChangeAuthorization=not_granted
childUseAuthorization=not_granted
```

它绑定完整 gate verification set、目标环境和外部审计记录摘要。approver 不能与 declarant、verifier、grant issuer 或 revocation authority 共用 principal。

grant 必须由 `deployment_grant_issuer` 签名，发生在 approval 之后，最长 5 分钟，只允许：

```text
action=deploy_synthetic_once
scope=single_synthetic_api_deployment
consumptionMode=external_atomic_single_use_required
productionChildGateChangeAuthorization=not_granted
childUseAuthorization=not_granted
```

它绑定 source commit、实现树、配置、S15、gate set、approval envelope、target environment、consumer 摘要和 grant ID。S16 只检查签名束要求外部原子单次消费；它自身没有消费账本。S17 的后续账本也是独立本地记录，不会反向把 S16 输出变成全局授权。

## 6. 执行与成功输出

在所有输入只存在于获批的不落盘通道时运行：

```text
npm run verify:synthetic-external-approval
```

验证顺序：

1. 读取、摘要钉住并验证公开策略；
2. 验证独立吊销 checkpoint；
3. 按原 `finalizedAt` 重构 S15，再以当前本机时间重跑 S15 当前状态；
4. 验证 19 项 gate、独立 approval 和短时 grant；
5. 要求 checkpoint 覆盖全部已签名工件；
6. 再读一次策略并比较完整身份；
7. 以 S15、策略、checkpoint、全部实际使用 key、gate、approval 和 grant 的最早失效时刻截断输出；完成时再次检查尚未过期。

成功输出只含摘要、计数、策略 revision、checkpoint sequence、布尔边界和固定状态。它不回显路径、策略正文、公钥、签名、原 approval/grant ID、证据正文、origin、AppID、AppSecret、dataset 或数据库内容。

必须保留并正确解释这些 `false`：

```text
trustPolicyExternallyAuthorizedByThisCommand=false
externalIdentityProofRetrievedByThisCommand=false
externalEvidenceContentRetrievedByThisCommand=false
externalAuditRecordRetrievedByThisCommand=false
trustedTimeVerified=false
revocationCheckpointMonotonicityExternallyVerified=false
approvalNonRepudiationEstablished=false
authorizationConsumptionVerified=false
replayProtectionPersisted=false
externalFactsVerifiedByThisCommand=false
deploymentAuthorization=not_granted
childUseAuthorization=not_granted
```

## 7. 稳定错误与处置

错误码按处置域分组：

- `..._ARGUMENT_INVALID`、`..._ACK_REQUIRED`、`..._STDIN_REQUIRED`、`..._INPUT_TOO_LARGE`、`..._INPUT_INVALID`、`..._SENSITIVE_INPUT`：修正受控输入通道，禁止改旧输出；
- `..._S15_SOURCE_INVALID`、`..._S15_SOURCE_CHANGED`、`..._S15_SOURCE_EXPIRED`：候选已漂移或过期，隔离当前 bundle，从 S12～S15 重新建立；
- `..._TRUST_ROOT_UNAVAILABLE`、`..._TRUST_POLICY_UNSAFE`、`..._TRUST_POLICY_CHANGED`、`..._TRUST_POLICY_INVALID`、`..._TRUST_POLICY_EXPIRED`：停止使用该策略路径和摘要，由信任策略责任人重新置入；
- `..._REVOCATION_INVALID`、`..._REVOCATION_EXPIRED`、`..._KEY_REVOKED`、`..._IDENTITY_REVOKED`：停止，不得降级到旧 checkpoint；
- `..._GATE_INCOMPLETE`、`..._GATE_INVALID`、`..._GATE_EXPIRED`、`..._SIGNATURE_INVALID`、`..._DUTY_SEPARATION_INVALID`：回到外部身份/证据核验与签名流程；
- `..._APPROVAL_INVALID`、`..._APPROVAL_EXPIRED`、`..._APPROVAL_REVOKED`：重新取得独立审批；
- `..._AUTHORIZATION_INVALID`、`..._AUTHORIZATION_EXPIRED`、`..._AUTHORIZATION_REVOKED`、`..._AUTHORIZATION_TARGET_MISMATCH`：禁止部署，重新建立目标绑定与 grant；
- `..._PRODUCTION_RESOURCE_REJECTED`、`..._VERIFICATION_FAILED`：保持全部门关闭并人工调查，不复制内部异常正文。

任何失败都不得通过回拨时间、改摘要、移除吊销项、关闭域名/TLS 校验、重写数据库或使用另一候选的签名来绕过。

## 8. S17/S18 本地边界与 S19 外部/生产硬门

S17 已在仓库、synthetic 数据根和策略目录之外增加独立本地 ledger，对本账本已观察 checkpoint 执行 sequence 单调、累计吊销、fork/撤销移除永久 block，并在一个 `BEGIN IMMEDIATE` 内提交本地单次使用或稳定拒绝记录。它没有改变 S16 自身只读、`unconsumed` 的历史边界，也没有把本地 receipt 变成部署授权。

S18 只准备 `locally_prepared_unsubmitted` 的本地摘要 intent，不发送外部请求。S19/获批外部系统仍至少需要完成：

1. 权威策略摘要的受控置入、轮换、责任人身份和主机本地卷/ACL 证明；
2. 声明人、核验人、审批人、grant issuer、revocation authority 与 consumer 的真实身份认证和角色生命周期；
3. 权威证据正文、来源、法律记录和不可变审计记录的实际取回与核对；
4. 可信时间、权威最新 checkpoint，以及跨 ledger/主机/consumer 的全局 sequence、防回滚和并发撤销；
5. ledger 文件的专用 OS 账号、ACL/所有权、加密、备份与外部防回滚锚；
6. grant 的全局单次消费，并把最终撤销判断、真实部署动作和可核验回执原子协调或提供安全补偿；
7. 部署后监控、失败补偿、回滚和成人受控设备 E2E。

只有这些外部门关闭后，才可另行授权一次受控 synthetic 部署；仍只允许合成家庭、模拟器或成人受控设备。正式法律文本、儿童易懂摘要、PIPIA、存量数据整改、逐类留存/删除、受托方约束、备案、AppGallery 审核和正式签名发布完成前，production 儿童功能门必须继续关闭。不得侧载、切换成人账号、关闭未成年人模式、开启孩子设备开发者模式或采用其他绕过正式分发的路线。
