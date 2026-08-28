# ADR-0009：外部部署 saga 仅允许测试专用、非规范性安全参考机

- 状态：已接受
- 日期：2026-08-29

## 背景

S19-readiness 已确认真实外部部署 saga 仍缺少获批的 authority、coordinator 和 deployer 协议，以及可信时间、全局最新 checkpoint、线性一致 reservation、durable outbox、目标 admission/fence、独立观察、补偿授权和回滚契约。在这些外部输入不存在时，本仓库不能自行创建本地“成功 saga”、假部署回执或可被操作员误用的部署入口。

另一方面，后续协议评审需要一组可执行的负向安全不变量，提前锁定以下底线：reservation 与 outbox 不能被拆成两个可接受状态；queued、HTTP 2xx、delivery ACK 或 target admission 不能替代独立平台事件、read-after-write 和健康观察；UNKNOWN 不能通过换 request、换 operation、复用 grant 或自动补偿逃逸。若把这些不变量做成 `scripts/` CLI、临时 SQLite 或 production 模块，会把本地模拟误述为真实 durability、global linearizability 或 readiness，并新增文件身份、sidecar、清理和同账号 ABA 风险。

## 决定

1. S19a 只增加位于 `server/test-support` 的纯同步、确定性 reference model，以及 `server/test` 中的回归。唯一调用 API 名必须以 `ForTest` 结尾；不得在 `scripts/`、生产 server 模块、package script 或 preflight production graph 中导出或调用。
2. reference model 只接受与 S19-readiness test seam 固定输出完全一致的 blocked report shape，且必须满足 `checks.testOnlyOverridesUsed=true`、17 个 blocker、14 个 required capability、全部外部事实为 false，以及三项授权未授予。形状相同但 `testOnlyOverridesUsed=false` 的 production report 必须独立稳定拒绝；纯函数只能绑定 caller 提供的 report shape 和摘要，不能认证该对象的真实来源。
3. 输入只能包含摘要化的 test-only operation（含绑定 fingerprint 的变更前/期望目标状态）、彼此分离的七个 test participant/fault-domain 和 exact-key synthetic trace。不得接受 endpoint、credential、trust root、真实 receipt、签名、路径、时间戳、raw S18 document、callback、adapter 或生产资源选择字段。
4. reference model 禁止访问环境、当前时间、文件、SQLite、网络、stdin/stdout、子进程、worker 或 timer；不创建临时数据库、journal、operation receipt 或 migration 011。现有 committed synthetic provenance 继续保持 43 个 production 实现文件和 001～010 十项迁移。
5. 模型中的 reservation 与 outbox 只能由一条不可拆分的 coordinator reference event 表示；这只检查 trace 形状，始终不证明真实事务、durability、global reservation 或单次消费。target admission、平台事件、独立 read-after-write 和 health 必须由不同 test participant 与 fault-domain 分别给出，缺一都不能形成完整 reference shape。
6. accepted、queued、HTTP 2xx、outbox dispatched、delivery ACK 和 signed ACK 全部是不具权威性的 transport observation，只能在 reservation/outbox 参考事件之后计数且不推进状态。完整正向 reference shape 也只能返回 `no_modeled_safety_violation_detected` 和 `minimum_selected_non_exhaustive`；不完整或阻断 trace 使用 `no_positive_conclusion` 结果。任何路径都不得输出 `conformant`、`success`、`deployed`、`approved` 或 `authorized` 状态。
7. dispatch outcome UNKNOWN 是 sticky。在同一完整 trace 内，模型只允许同一摘要化 operation/fingerprint/fence 继续形成完整的 admission → platform event → independent read → health test shape，或在从未观察到 admission/platform/read 的前提下形成同时绑定变更前状态、target fence high-water 与低 fence 拒绝声明的 modeled no-effect shape；两者都不能认证真实 external reconciliation 或权威 no-effect proof。矛盾 read 进入独立的 unresolved 状态，不能再被 no-effect shape 洗掉。换键、换 operation/fence、重新 reservation 或普通 404/timeout/ACK 都不能在该 trace 内解除 UNKNOWN。
8. S19a v1 不实现正向 compensation/rollback 链。unhealthy 只进入 `test_only_compensation_protocol_required`；任何 compensation、rollback、release、refund 或 grant-reuse 事件稳定拒绝。输出固定 `compensationProtocolAvailable=false`、`compensationAuthorized=false`、`compensationPerformed=false`、`rollbackSafetyVerified=false`、`originalGrantReusable=false`。
9. 所有返回继续固定 caller report 来源未认证、`referenceModelNormative=false`、`approvedProtocolConformanceAssessed=false`、`externalProtocolConformanceVerified=false`、`readyForExternalIntegration=false`、`realDeploymentStatus=not_observed`，并保持部署、儿童功能门和儿童使用授权均未授予。模型达到 test-only 完整 shape 也不关闭 S19-readiness 的任何 blocker。
10. reference model 没有跨调用持久状态或状态 token；sequence、replay、UNKNOWN 与 fence 约束只检查调用方提交的单条完整 trace。重新调用纯函数不能证明跨 trace 幂等、全局 fence 高水位、历史连续性或防回滚，输出必须继续把这些真实能力标为未验证。

## 影响

- 后续外部协议或 adapter 可以把 trace 投影到同一组负向安全不变量，较早发现 ACK 假成功、观察缺项、摘要漂移、参与方混域、冲突 replay 和 UNKNOWN 逃逸。
- 仓库不会因此拥有真实 coordinator、deployer、全局状态、目标 fence、补偿器或部署通道；S19-readiness blocker report 仍是唯一 operational 输出，且始终返回 blocked。
- reference model 不进入 committed production provenance 清单；其通过只能说明“在非穷尽的已选测试模型中未发现违规”，不能作为发布、部署、儿童使用或合规证据。
- 不使用临时 SQLite，避免把单机 `BEGIN IMMEDIATE` 当成跨 fault-domain 原子性，也避免新增路径、sidecar、清理和 precise ABA 攻击面。

## 后续动作

- 由受权外部系统提供并批准 authority/coordinator/deployer、身份、trust root、可信时间、checkpoint、reservation/outbox、admission/fence、观察和补偿协议；在此之前不得新增 production adapter 或网络入口。
- 获批协议到位后，以新 ADR 明确哪些 test-only shape 被真实协议取代，并为真实 adapter 建立独立的认证、幂等、并发、崩溃、UNKNOWN 对账与 rollback 安全测试。
- 只有取得独立 compensation authorization、new operation/higher fence、恢复目标绑定和独立观察契约后，才可设计 compensation reference v2；不得在 v1 中推断或预留可调用的补偿操作。
- 生产儿童功能门继续关闭；正式法律文本、PIPIA、存量整改、留存/删除、备案、签名发布和成人受控设备验证等硬门仍须分别完成。
