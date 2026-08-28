# ADR-0010：设备积分申请详情与操作回执对账边界

- 状态：已接受
- 日期：2026-08-29

## 背景

ADR-0007 已允许同一孩子的任一当前有效设备补充或取消既有积分申请，并要求所有写操作使用 `expectedRevision`、持久幂等键和不可变成功事件。S8 的 HarmonyOS 客户端只实现了申请创建与本人列表；当未来补充、取消或重新提交请求遇到响应丢失时，列表不能证明某个来源设备、动作、键和载荷的精确历史结果，也不能安全区分“完成但当前申请已继续演进”和“当前快照未观察到完成事件”。

若把未观察到事件解释成 no-effect、换新键重试，或把历史回执当作当前资源状态，可能制造重复动作、清除仍需恢复的本地意图，或在跨设备、撤权和会话轮换后泄露幂等身份。另一方面，积分申请当前缺少设备作用域的单条详情，客户端即使恢复历史完成回执也无法再读取当前状态。未决文字的生产保留期限与监护人授权安全放弃策略尚未获批，因此本切片只能建立只读协议基座，不能开放 mutation UI 或新的持久意图生命周期。

## 决定

1. 新增设备 Access 专用 `GET /api/v2/me/point-requests/:id`。家庭和儿童全部从有效设备会话推导；同一孩子任一当前有效设备可以读取最小详情，但来源 `clientRequestId` 只向来源绑定回显。跨家庭、跨儿童、无权或已撤销设备统一隐藏资源存在性。
2. 新增 `POST /api/v2/me/point-request-operations/resubmit/reconcile` 与 `POST /api/v2/me/point-request-operations/cancel/reconcile`。POST 仅用于在 body 和 `Idempotency-Key` 中安全承载原写请求身份；服务端必须在只读事务中查询历史，不得执行 mutation、生成事件、写入数据库、创建 migration 或推进申请状态。禁止 query selector。
3. 对账身份精确绑定来源 `deviceBindingId`、原 action、申请 ID、`expectedRevision`、resubmit 的 NFC/trim 规范化 description，以及原 `Idempotency-Key` 摘要和 canonical 请求指纹。ADR-0007 中“同孩子任一有效设备可执行既有补充/取消”保持不变；历史幂等回执因事件身份绑定来源设备，只允许来源设备恢复。同孩子其他设备可读详情，但不可对账该来源回执。
4. `completed` 只表示在同一一致性快照中观察到唯一、完整且内部一致的历史成功事件。服务端必须验证家庭、儿童、来源绑定、action、键摘要、请求指纹、actor、HTTP 结果、不可变事件载荷、`fromStatus`/`toStatus`、`resultRevision=expectedRevision+1`、规范时间、当前记录的单调后续演进和同 revision 事件唯一性；缺失当前申请、事件损坏、重复或无法证明一致时稳定返回 `IDEMPOTENCY_RESULT_UNAVAILABLE`，同键不同 action/申请/载荷返回 `IDEMPOTENCY_CONFLICT`。
5. 历史回执与当前资源彻底分离。`completed` 只返回当时的 `fromStatus`、`toStatus`、`resultRevision` 和 `recordedAt`，固定 `currentResourceStateIncluded=false`；申请可在该事件之后继续演进，客户端必须再调用单条详情读取当前状态。历史 cancel 是终态，必须与当前 revision 精确相等；resubmit 可容许可证明的后续演进。
6. `not_observed` 只表示当前一致性快照没有观察到来源设备、动作、键和精确载荷对应的完成事件，不代表操作未执行，也不是权威 no-effect proof。所有结果固定 `noEffectProven=false`、`sameLogicalOperationMayUseNewIdempotencyKey=false`。`not_observed` 固定 `safeToClearLocalIntent=false`、`retryDisposition=retry_exact_original_only`；客户端必须保留原意图并只允许原键原载荷重试。`completed` 固定 `safeToClearLocalIntent=true`、`retryDisposition=read_current_detail_do_not_repeat`。
7. `POINT_REQUESTS_ENABLED` 关闭时，只允许上述历史对账入口继续用于恢复已经发生或结果未知的既有操作；设备单条详情和所有正常写操作仍受该门控制。该窄例外不豁免 `HARMONY_CHILD_ENABLED`、`DEVICE_PAIRING_ENABLED`、当前有效 Access/Refresh token family 与 rotation、active binding/session、儿童隐私 active、创建绑定监护人的 active 授权、账户和家庭/儿童/设备作用域。撤回监护授权继续阻断处理并撤销相关设备会话。
8. HarmonyOS 本轮只增加精确 allowlist、canonical request builder、严格 DTO/parser 和只读 client 方法。解析必须拒绝未知字段、`null` 漂移、不安全 revision、错误 action/ID/transition/observation，以及把历史结果伪装成当前资源的响应。对账 transport 本身标记为 `mutating=false`，只表示本次 HTTP 调用不执行 mutation；任何错误或 `not_observed` 都不能解除原写操作的结果未知状态。
9. 本轮不新增 PATCH/cancel mutation client、页面按钮、业务 coordinator、AssetStore mutation intent 生命周期、迁移、外部网络、部署或 production adapter。未决 description 的生产保留期限和监护人授权安全放弃策略获批前，不得把补充、取消或重新提交接入 UI。
10. S20a 与真实 S19 外部部署 saga 正交。它不关闭 S19-readiness 的 17/14 非穷尽硬门，也不形成 authority、coordinator、deployer、生产数据、凭据、联网、部署、发布或儿童使用事实。

## 影响

- 响应丢失后的客户端可以先恢复来源设备的精确历史回执，再读取当前详情，不必依赖列表猜测，也不会把后续状态演进误当成幂等冲突。
- `not_observed` 不会被错误降格成“安全换键”，损坏或歧义事件也不会产生伪完成回执。
- 同孩子跨设备共享当前详情与来源设备专属幂等回执各自保持最小可见范围，家庭、儿童、设备和会话隔离不因对账放宽。
- 功能门关闭仍可恢复历史结果，但不能借恢复入口读取详情、创建新申请或执行补充/取消。
- 没有新的持久客户端状态或产品动作；本切片只关闭技术协议缺口，不关闭产品保留与安全放弃决策缺口。

## 后续动作

- 由产品、合规与监护授权流程明确未决申报文字的逐类保留期限、删除/撤权同步，以及监护人授权的安全放弃条件和审计证据。
- 上述策略获批后，以独立切片设计 resubmit/cancel mutation coordinator、不可同步 AssetStore intent、重启/结果未知恢复、当前详情二读和 UI 状态机；不得在 `not_observed` 时清意图或换键。
- 在成人受控设备和获批独立 synthetic API 上验证 HUKS/AssetStore、前后台、重启、Access/Refresh 轮换、撤权和网络结果未知；不得使用生产数据或儿童设备侧载。
- 正式法律文本、儿童易懂摘要、PIPIA、存量整改、逐类留存/删除、密钥与备份、备案、AppGallery 审核和 RELEASE 签名发布等生产硬门继续分别完成，全部满足前儿童功能门保持关闭。
