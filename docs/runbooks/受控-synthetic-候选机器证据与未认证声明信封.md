# 受控 synthetic 候选机器证据与未认证声明信封

> 适用范围：阶段 1 / S15，在尚未启动服务或推进数据库状态的受控 synthetic 候选上，离线绑定机器证据并封装外部声明。
>
> 两个命令都是 review-only。它们不认证声明人、不验证外部事实、不读取部署现场生产门、不签发部署许可，也不允许儿童使用。

## 1. 两阶段边界

S15 提供两个 CLI：

1. `npm run capture:synthetic-candidate-evidence`（Phase A）把同一候选的 S12 schema 4 artifact、S13 bootstrap 前空根 evidence、S14 bootstrap evidence、当前已提交实现、当前 S12 配置聚合、物理根上下文摘要和当前只读 pristine SQLite/receipt 绑定成 30 分钟 machine subject。
2. `npm run finalize:synthetic-candidate-evidence`（Phase B）重新执行 Phase A 的机器状态核验，再检查 19 个固定顺序声明信封的字段、subject 绑定、完整性与时效。

两阶段都会启动受限的只读 Git 子进程，以只读、immutable URI 打开 synthetic SQLite，并在内存数据库中建立参考 schema。它们不会写目标 SQLite、创建 WAL/SHM/`.secret`、联网、启动服务、持久化证据、部署、读取生产数据或修改 production 儿童门。

成功输出是 stdout 上一行脱敏 JSON，CLI 自身不保存。只有获批的外部证据消费者可以把输出写入受控证据系统；禁止把 artifact、路径、资源身份或声明明文提交到 Git。

## 2. 执行前硬门

任一项不成立即停止：

- 当前候选已经提交，index、工作树实现文件和 `HEAD` 一致；`npm run verify:synthetic-api-preflight` 的提交实现/离线守卫夹具自检通过；随后用同一候选配置执行 `npm run preflight:synthetic-api -- --output <系统临时目录下全新绝对目录>`，实际候选 artifact 为 schema 4、39 个实现文件和精确 001～010 迁移集；
- S12 artifact、S13 bootstrap 前空根 schema 1 evidence、S14 schema 1 evidence 来自同一候选、同一配置和同一数据根，均由获批证据通道保留；
- S14 bootstrap 请求中的 `candidateProvenance` 来自该次 S12 artifact，live receipt 中三项 provenance 与之相同；
- 数据库仍处于刚完成 bootstrap 的最小状态：一个默认合成家庭、一个未轮换凭据的合成成人管理员、四类法律元数据和一个不可变回执；没有儿童、授权、设备、会话、积分、规则、申请、行权、审计或删除作业；
- S14 后没有启动 server、登录、绑定 OpenID、轮换管理员密码、生成 `.secret` 或写入任何正常运行状态；`data` 精确只有 SQLite 主文件，无 WAL/SHM；
- 根、父目录、主机和执行 OS 账号是本次获批候选；不使用生产或未知数据库、备份、快照、身份、密钥、路径或真实家庭数据；
- 19 项外部核验可以在 capture 后 30 分钟内真实完成。时间不足时先停止并重新演练，不得预填或伪造观察时间。

迁移 010 在 S15 中扩展了来源和管理员 verifier 绑定。任何由旧 S14 版本创建的数据库必须隔离，从当前候选的全新 S13 根重新 bootstrap；禁止补列、升级或接管。

## 3. ACK 与 stdin 契约

两阶段都要求：

```text
SYNTHETIC_CANDIDATE_EVIDENCE_ACK=assemble-review-only-not-deployment-v1
```

ACK 不是批准或秘密，只表示操作员理解本命令仅组装复核材料。两个 CLI 除 `--help` 外不接受参数，并只接受非 TTY stdin 上一个 UTF-8、最多 256 KiB 的 canonical JSON 文档：

- 必须精确等于 `JSON.stringify` 的单行结果；
- 只允许末尾可选的一个 LF；CRLF、缩进、额外空白、重复键、尾随数据和替代编码均拒绝；
- 输入不得包含当前 origin、AppID、AppSecret、dataset、数据根、SQLite 路径、监护声明 URL/版本或其 JSON 转义形式；
- 不得用普通文件、shell history、日志、截图或工单中转输入。

## 4. Phase A：machine subject

输入顶层字段必须精确为：

```json
{"schemaVersion":1,"purpose":"synthetic_candidate_machine_capture","candidateId":"synthetic-candidate-<非敏感唯一值>","s12Preflight":{},"s13PreBootstrap":{},"s14Bootstrap":{}}
```

大括号只是结构占位，不能直接执行：

- `candidateId` 必须以 `synthetic-candidate-` 开头，后缀为 16～79 个 `[a-z0-9_-]` 字符且首字符只能是小写字母或数字；不得包含路径、资源明文或真实身份，输出只保留其 SHA-256；
- `s12Preflight` 必须是当前 HEAD 和当前 S12 配置聚合实际生成的完整 schema 4 artifact；
- `s13PreBootstrap` 必须是 bootstrap 前空根实际生成的完整 schema 1 evidence；
- `s14Bootstrap` 必须是同一根实际生成的完整 schema 1 evidence，且与 live receipt 精确一致。

运行：

```text
npm run capture:synthetic-candidate-evidence
```

成功结果 `profile=synthetic-candidate-machine-subject`、`result=offline-machine-evidence-validated`。它绑定：

- 当前 `sourceCommit`、实现树摘要、39 个实现文件和 10 个迁移；
- 当前 S12 配置摘要，包括规范化可信代理集合，以及折叠进 sensitive binding 的 AppSecret-keyed HMAC；该 HMAC 不回显 secret，但也不证明 secret 的外部独立性、托管合规或声明人身份；
- 三阶段 artifact、marker、dataset、deployment/schema/request/approval/admin/legal 摘要；
- canonical 物理根、批准父目录、root/data/SQLite 文件身份以及主机/OS 账号上下文的摘要；
- SQLite 主文件前后字节与元数据快照、live 回执和未轮换管理员 verifier；
- 当前最小数据库状态及 sidecar/运行 secret 不存在。

`subjectSha256`、`candidateBindingSha256`、`rootContextSha256` 等外层绑定是未签名内容摘要，不是数字签名、可信时间戳或外部批准；S12 的 sensitive binding 内部确实包含 AppSecret-keyed HMAC，但它只用于配置身份漂移检测，不能认证 S15 subject、声明人或外部事实。`rootContextSha256` 不公开路径或账号，但也不能替代现场 ACL/所有权证明。

必须逐字保留以下边界：

- `checks.historicalSequenceVerified=false`：事后组合 artifact 不能证明 S13 一定先于 S14；
- `checks.runtimeSecretIndependenceVerified=false`：绑定当前 secret 身份不等于证明其来源独立或托管合规；
- `checks.localClockExternallyTrusted=false`：30 分钟窗口依赖本机时钟，不是可信时间源；
- `checks.currentDatabasePristine=true` 只描述本次被前后快照夹住的当前只读观察，不证明历史上从未写入；
- 同权限攻击者在观察间修改后完整恢复的瞬态行为仍不能由本地 Node 进程彻底排除，必须依赖外部 OS 账号、ACL、所有权和审计硬门；
- 当前 HEAD 已被工具绑定，但该 commit 是否获外部责任人批准仍未验证。

subject 的 `validUntil` 固定为 `capturedAt` 后 30 分钟。过期后必须重新从 Phase A 开始，不能延长或手改。

## 5. Phase B：19 项未认证声明

输入顶层字段必须精确为：

```json
{"schemaVersion":1,"purpose":"synthetic_candidate_attestation_finalize","captureInput":{},"machineSubject":{},"externalAttestations":[]}
```

- `captureInput` 必须是 Phase A 的原始完整输入；
- `machineSubject` 必须是 Phase A 的原始完整输出；
- `externalAttestations` 必须按下表顺序精确包含 19 项，不能缺失、增加、重排或跨 subject 拼接。

每项字段必须精确为：`gateId`、`subjectSha256`、`evidenceReferenceSha256`、`declarantRole`、`sourceType`、`observedAt`、`expiresAt`、`state`、`signatureStatus`。其中：

- `subjectSha256` 精确等于 Phase A 输出；
- `evidenceReferenceSha256` 是声明方提供的非重复、非占位 64 位小写摘要字段，不是证据正文；S15 不取回引用、不重算内容摘要，也不证明引用存在、内容匹配或来源权威；
- `state` 精确为 `declared_satisfied_not_authenticated`；
- `signatureStatus` 精确为 `not_verified`。

| 顺序 | `gateId` | `declarantRole` | `sourceType` |
| ---: | --- | --- | --- |
| 1 | `app_id_provisioning` | `application_operator` | `authority_record` |
| 2 | `developer_authorization` | `application_operator` | `authority_record` |
| 3 | `app_secret_independence` | `security_reviewer` | `security_review` |
| 4 | `request_domain` | `network_operator` | `authority_record` |
| 5 | `business_domain` | `network_operator` | `authority_record` |
| 6 | `dns` | `network_operator` | `authority_record` |
| 7 | `tls` | `network_operator` | `authority_record` |
| 8 | `proxy_port_boundary` | `network_operator` | `host_inspection` |
| 9 | `os_account` | `platform_administrator` | `host_inspection` |
| 10 | `filesystem_acl` | `security_reviewer` | `host_inspection` |
| 11 | `filesystem_owner` | `security_reviewer` | `host_inspection` |
| 12 | `disk_isolation` | `platform_administrator` | `host_inspection` |
| 13 | `backup_isolation` | `platform_administrator` | `host_inspection` |
| 14 | `database_isolation` | `security_reviewer` | `security_review` |
| 15 | `runtime_secret_management` | `security_reviewer` | `security_review` |
| 16 | `infrastructure_connectivity` | `platform_administrator` | `host_inspection` |
| 17 | `legal_records_publication` | `legal_reviewer` | `legal_review` |
| 18 | `devtools_domain_tls_validation` | `application_operator` | `authority_record` |
| 19 | `production_root_isolation` | `security_reviewer` | `security_review` |

时间契约：

- `observedAt` 和 `expiresAt` 必须是规范 ISO 时间；
- `capturedAt <= observedAt <= machineSubject.validUntil`；
- `observedAt` 最多允许比本机 finalize 时间未来 5 分钟，仅用于时钟偏差，不允许伪造未来观察；
- `expiresAt` 必须晚于 finalize 和 `observedAt`，单项最长 24 小时；
- finalize 必须发生在 30 分钟 subject 窗口内；最终 `validUntil` 取 subject 到期与最早声明到期的较早者。

运行：

```text
npm run finalize:synthetic-candidate-evidence
```

成功只意味着 `result=attestation-envelopes-present`。输出必须继续包含：

```text
checks.attestationAuthenticityVerified=false
checks.externalFactsVerified=false
externalFactsVerifiedByThisCommand=false
deploymentAuthorization=not_granted
productionChildGateState=not_observed
childUseAuthorization=not_granted
```

任何系统都不得把该输出当作部署令牌、签名审批、生产门现场状态、法律合规结论或儿童可用证明。

## 6. 稳定错误码与处置

| 错误码 | 含义与动作 |
| --- | --- |
| `SYNTHETIC_CANDIDATE_ARGUMENT_INVALID` | 参数不符合无参数/`--help` 契约；移除参数。 |
| `SYNTHETIC_CANDIDATE_ACK_REQUIRED` | ACK 缺失或不精确；重新核对 review-only 边界。 |
| `SYNTHETIC_CANDIDATE_STDIN_REQUIRED` / `SYNTHETIC_CANDIDATE_INPUT_TOO_LARGE` | stdin 缺失、是 TTY、为空或超过 256 KiB；修正受控内存通道。 |
| `SYNTHETIC_CANDIDATE_INPUT_INVALID` | JSON、字段、编码、LF 或时间契约不精确；不得手改旧输出。 |
| `SYNTHETIC_CANDIDATE_SENSITIVE_INPUT` | 输入含当前敏感配置明文或转义形式；停止并按证据泄露流程检查通道。 |
| `SYNTHETIC_CANDIDATE_SOURCE_INVALID` | artifact、subject 或 provenance 形状不可信；重新生成。 |
| `SYNTHETIC_CANDIDATE_SOURCE_CHANGED` | HEAD、实现、根、数据库或机器状态在核验间漂移；停止并调查并发写入。 |
| `SYNTHETIC_CANDIDATE_BINDING_MISMATCH` | S12/S13/S14/config/live receipt 不属于同一候选；隔离，禁止拼接。 |
| `SYNTHETIC_CANDIDATE_STATE_ADVANCED` | 数据库、凭据或 sidecar 已进入运行状态；该根不能再生成 pristine subject。 |
| `SYNTHETIC_CANDIDATE_ATTESTATION_INCOMPLETE` | 19 项信封缺失或数量错误；不得以空项替代。 |
| `SYNTHETIC_CANDIDATE_ATTESTATION_INVALID` | 顺序、角色、来源、subject、state、签名状态或时间无效；回到权威证据流程。 |
| `SYNTHETIC_CANDIDATE_ATTESTATION_EXPIRED` | subject 或信封已过期；重新 capture 和真实观察。 |
| `SYNTHETIC_CANDIDATE_PRODUCTION_RESOURCE_REJECTED` | 检测到生产形态、根/数据库不安全或下层 synthetic 门失败；立即停止。 |
| `SYNTHETIC_CANDIDATE_VERIFICATION_FAILED` | 未分类 fail-closed；保存稳定码并人工调查，不复制内部异常正文。 |

失败时 stdout 必须为空，stderr 只应有一行稳定码。任何失败都不得通过启动服务、修库、删除 sidecar、改回执、改时间或手工重写 artifact 来绕过。

## 7. 完整执行顺序与后续硬门

1. 保持全部 production 儿童门和跟踪客户端网络关闭；准备获批、全新的 S13 根。
2. 固定候选 commit 与同一 synthetic 配置；先运行 `npm run verify:synthetic-api-preflight` 完成提交实现/离线守卫夹具自检，再运行 `npm run preflight:synthetic-api -- --output <系统临时目录下全新绝对目录>` 生成并保存实际 S12 schema 4 artifact。两者用途不同，verifier 的临时 fixture artifact 会被删除。
3. S13 prepare/verify，保存 bootstrap 前空根 evidence。
4. 从同一 S12 artifact 机械注入 S14 provenance，经不落盘 stdin bootstrap，保存 S14 evidence，立即移除 bootstrap ACK。
5. 在任何 runtime、登录、secret 或业务演进前设置 S15 ACK，组装 Phase A canonical 输入并 capture。
6. 在 30 分钟内由各责任角色根据真实权威记录或现场检查形成 19 项声明；不得预填时间或复用另一 subject。
7. 用原 capture 输入、原 subject 和 19 项声明执行 finalize；把输出交给获批的外部证据消费者。
8. 外部系统另行认证声明人、验证权威事实与证据引用，并签发独立 checkpoint、gate verification、approval 和短时 grant。S15 不完成这些动作。
9. 用 S16 verifier 对完整签名束做本地只读验证；S16 成功仍只是调用方策略下的 `unconsumed`，不是部署许可。
10. 按 S17 手册初始化独立本地 ledger，并可对同一 S16 verification document 重新核验后提交一次本地使用记录；本 ledger receipt 不是全局消费或部署许可。
11. 只有 S18/获批外部系统认证权威与 consumer、提供可信时间和全局最新 checkpoint，并把最终撤销、全局单次消费、真实部署动作和可核验回执安全协调，且全部外部硬门关闭后，才可执行一次受控 synthetic 部署。
12. 部署后仍只用合成家庭在模拟器或成人受控设备完成网络 E2E、HUKS/AssetStore、微信 DevTools/真机和撤销 smoke。
13. 正式法律文本、PIPIA、存量数据整改、备案、AppGallery 审核和所有生产发布门全部完成前，不开放儿童实际使用。

S16 已提供本地签名束 verifier，但只确认调用方提供策略下的签名、吊销 checkpoint、gate、approval 和 grant 绑定。S17 随后只在一个独立本地 ledger 实例内提供 checkpoint sequence 单调、累计吊销和本地 compare-and-record；它仍不认证策略权威或真实身份，不取回证据/审计正文，不提供可信时间、权威最新 checkpoint、跨主机全局单次消费或实际部署。以上外部硬门继续属于 S18/获批外部系统；不得把 S15、S16 或 S17 输出升级措辞为部署许可。
