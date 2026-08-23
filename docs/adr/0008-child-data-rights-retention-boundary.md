# ADR-0008：儿童数据权利、撤回与留存阻断边界

- 状态：已接受
- 日期：2026-08-23

## 背景

儿童数据权利不能只做一个删除按钮。请求需要验证当前操作人、其与目标儿童的监护证据、动作意图和并发版本；撤回授权后仍必须能查阅请求和继续删除，不能因为隐私状态不再 active 或应急关闭功能门而封死入口。另一方面，积分流水、审批事件、授权证据和安全会话可能具有账本、争议处理或法定留存需要。在逐类期限、保留依据、备份同步清理和去标识方案获批前，直接物理删除或返回“已完成”会制造不可逆的数据与合规错误。

## 决定

1. 新建数据权利请求的唯一入口是 `POST /api/v2/children/:id/data-rights-requests`，首版公开支持 `access`、`export`、`correct`、`delete`、`terminate`。授权撤回继续使用既有 `/consents/withdraw`，但必须在同一事务写入 009 请求和状态事件，不能形成绕过审计的第二条路径。
2. `CHILD_DATA_RIGHTS_ENABLED` 只门控新的 access/export/correct 请求，不绑定 `HARMONY_CHILD_ENABLED`。withdraw/delete/terminate 属于安全或权利入口，既有请求详情、回执和已授权动态导出属于已发生流程，均不能被新建功能门封死。
3. 家庭成人身份本身不等于监护关系。请求必须从当前 Bearer 推导仍在同一家庭的成人，并绑定本人对精确儿童的最新历史监护证据；证据可为 active、withdrawn 或 superseded，但必须包含 `childProfile=true`、`guardian=full`。首版以该证据代理持续关系有效性；独立关系核验仍是生产硬门。跨家庭、同家庭无证据和其他监护人的请求统一隐藏资源存在性。
4. 每个动作使用不同的重新认证 purpose：`child_data_access`、`child_data_export`、`child_data_correct`、`child_data_delete`、`child_service_terminate`；撤回保持 `child_consent_withdraw`。断言必须在有效期内由同家庭同成人消费一次，并与不可变请求证据关联。
5. `data_rights_requests` 与字段白名单 `audit_events` 共同形成 `requested → verified → completed/rejected` 或删除类 `requested → verified → processing` 的 revision 状态机。成功写请求使用只落 SHA-256 摘要的持久幂等键；相同载荷重放返回当前请求，冲突载荷拒绝。请求核心证据禁止改写、替换或删除，其生命周期只能在先写事件并通过 revision CAS 后受控推进；审计事件和策略阻断作业整行禁止更新、替换或删除。
6. access/export 完成后只在短授权窗口内允许本人通过 `requestId` 动态生成快照；GET 不接受秘密、选择身份的请求体或查询字段，导出正文不落库。快照按家庭、儿童和本人监护证据重新过滤，排除密码、OpenID、密钥、公钥、Token/幂等摘要、fingerprint、challenge 和内部 actor；保留解释儿童档案、积分、授权、设备生命周期、流水、审批及本人行权所需的最小字段。
7. 首版 correct 只支持儿童当前别名，并以 expected privacy revision、旧值条件更新和新旧值摘要防止竞争。更正不改写授权版本、积分流水、point request、事件、规则或别名历史快照；需要修正账本含义时必须使用未来显式冲正流程。
8. delete/terminate 原子写入不可变 `blocked_policy/policy_pending` 作业、把精确儿童置为 `deletion_pending`、撤销其全部绑定/配对/会话 challenge、Access/Refresh 会话并推进旧儿童 Token 失效下限。兄弟姐妹和其他家庭不受影响。009 不提供删除执行入口，数据库禁止请求完成或儿童进入 deidentified/deleted；未来只有经审查的新迁移才能引入策略绑定的执行状态机。
9. 任一授权撤回继续全局阻断儿童新增处理、撤销设备会话并推进旧儿童 Token 失效下限。若儿童已处于 processing_blocked 或 deletion_pending，撤回保留更严格状态和首次阻断时间，不得降级；原监护人仍可凭历史证据查看本人回执并发起后续权利请求。

## 影响

- 监护人可以在授权撤回或 Harmony 止损门关闭后继续获得行权入口与可追溯回执。
- 别名更正、删除或终止不会破坏积分与审批账本，也不会错误宣称正式删除已经完成。
- 设备与旧儿童凭据在删除/终止受理时立即失效，且状态、作业、撤销和请求共用一个事务；任何中途失败都会整体回滚。
- 009 是前向迁移。应用回退必须保留请求、审计和策略阻断作业；生产旧库仍受 ADR-0005 的迁移前备份门约束。

## 后续动作

- 定稿并发布正式法律文本、易懂摘要与真实行权联系方式，完成 PIPIA、存量儿童数据盘点/整改和监护关系持续有效性方案。
- 形成逐类留存表，覆盖档案、授权、设备、会话、申请、流水、行权、审计、安全日志和备份；明确期限、依据、备份同步清理、责任人及争议处理。
- 决定不可变账本的去标识/按儿童加密与密钥销毁方案后，以新 ADR 和前向迁移替代 `blocked_policy`；在此之前不得开启删除执行器或儿童生产功能。
- S6 小程序只展示并调用本 ADR 的既有接口，不在客户端重建授权、关系或删除状态判断。
