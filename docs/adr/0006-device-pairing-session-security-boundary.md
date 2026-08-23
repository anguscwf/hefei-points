# ADR-0006：设备配对、设备身份与会话轮换边界

- 状态：已接受
- 日期：2026-08-23

## 背景

旧会话是面向成人 Web/小程序的长时 HMAC Token：签名截断、可从 query/body 读取，没有设备公钥、持久会话、Refresh 单次轮换或重用检测，不能作为未成年人设备身份。设备配对还同时面对六码猜测、公开设备身份抢注、跨家庭绑定、网络重试、并发状态推进和监护授权撤回后的持续处理风险。

## 决定

1. 设备能力只通过 `/api/v2` 提供，并由 `HARMONY_CHILD_ENABLED` 与 `DEVICE_PAIRING_ENABLED` 双门控制。读取和撤销等安全管理操作在业务门关闭后仍可执行；旧儿童登录和旧儿童管理门不会被连带开启。
2. 家长以当前家庭、儿童和本人 active 监护授权创建十分钟配对。六码短码只保存分域 HMAC；家长另持有独立高熵确认 challenge。设备 claim 只返回不透明 Bearer claim，家长必须用 `expectedRevision` 完成独立二次确认。
3. 设备密钥固定为 canonical DER SPKI 表示的 P-256 ECDSA/SHA-256。设备对包含 purpose、challenge、binding 和可选 session 的分域 payload 签名。绑定只有在公钥 proof 成功后才能从 pending 激活。
4. 公开设备 ID 或公钥摘要在 pending 阶段不取得全局所有权；只对 active 绑定建立部分唯一索引。这样复制公开材料但没有私钥的申领不能抢注，撤销后的物理设备可以通过新的监护流程重新配对。冲突统一返回 `DEVICE_ALREADY_BOUND`。
5. claim、Access、Refresh、短码、家长 challenge 和 proof challenge 的原始值不落库；持久化值使用完整 SHA-256 或带服务端密钥的分域 HMAC。claim、Access 和 Refresh 严格只接受 `Authorization: Bearer`。
6. Access 有效期十五分钟；Refresh 有效期三十天且到期时间不随轮换延长。只有 Access 剩余五分钟内可以签发 Refresh proof，每个 session 同时最多一个 pending challenge。Refresh 成功后旧代进入 rotated、新代沿用同一 token family；非精确旧 Refresh 重用、proof 锁定或固定幂等宽限过期会撤销整个 family。
7. 完成类请求使用持久幂等键、请求指纹和固定五分钟重试宽限。无效 proof 也持久记录最后的幂等键与指纹，完全相同的失败重试不增加计数；同键异请求返回 `IDEMPOTENCY_CONFLICT`。
8. SQLite 复合外键和触发器约束家庭/儿童/绑定作用域、状态 revision、会话代际、challenge 结果链路及级联撤销。监护授权撤回形成儿童全局处理阻断，并在同一事务撤销该儿童所有 pending/active 绑定、会话和签名 challenge；设备或单会话撤销同样即时使相关凭据失效。
9. 猜码失败按设备与客户端来源持久计数和锁定，过期窗口惰性清理且表有硬容量上限。转发地址默认不可信；生产开启设备配对前必须明确选择直连模式，或配置可信反向代理 IP/CIDR。该边界不替代边缘限流。

## 影响

- 设备身份不再依赖旧用户 Token、客户端传入 child ID 或可伪造的设备声明。
- 网络丢包可以在有限时间内安全重试，同时旧 Refresh 不会无限期重新导出有效凭据。
- 数据库保留撤销和轮换证据，代码回退采用关闭功能门并保留 007 数据，不能通过删表回滚。
- 设备端必须安全保存 P-256 私钥、Access 和 Refresh；服务端只保存公钥和凭据摘要。
- 生产部署必须补齐可信代理/边缘限流、容量监控、留存与删除周期；这些仍是生产开启前的硬门。

## 后续动作

- S3 本人只读 API 只能从已验证设备 Access 上下文推导家庭、儿童、绑定和会话，不接受客户端覆盖。
- 在 PIPIA 和正式留存/删除方案中确定撤销绑定、历史 session、challenge、失败窗口和安全审计证据的保存周期与清理作业。
- 正式发布前完成法律文本、存量数据整改、代理拓扑、边缘限流、密钥轮换、备份恢复和 AppGallery 审查验证。
