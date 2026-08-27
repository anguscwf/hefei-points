# 受控 synthetic 初始管理员与法律证据引导

> 适用范围：阶段 1 / S14，在 S13 新建数据根中一次性建立最小 synthetic 成人管理员和法律元数据。
>
> 本手册不授权联网、部署、使用生产资源、录入真实家庭数据或开放生产儿童功能。只有获批操作员可在受控非生产环境执行。

> S15 兼容性说明：迁移 `010_synthetic_bootstrap_receipt.sql` 在尚无外部 S14 数据库或部署的前提下扩展了来源与凭据绑定。任何由较早 S14 版本创建的数据库都不是当前候选输入，必须隔离并从当前已提交候选的全新 S13 根重新 bootstrap；禁止补列、升级、复制或接管旧库。

## 1. 目的与边界

`npm run bootstrap:synthetic-database` 只完成以下本地动作：

1. 复核完整 S12 synthetic 配置、S13 marker 和物理数据根；
2. 要求目标 SQLite 路径此前不存在；
3. 在一个 `BEGIN IMMEDIATE` 事务内执行审计清单中的迁移；
4. 把默认家庭固定为“合成默认家庭”，创建一个成人 `admin`；
5. 写入四类获批 synthetic 法律文本元数据；
6. 最后写入单例、不可更新、不可删除的完成回执；
7. 输出不含密码、标识明文、origin、AppID、AppSecret 或本机路径的 schema 1 结果。

命令不创建儿童、监护授权、设备、会话、积分账户、流水、规则、申请、行权请求、审计事件或删除作业，也不创建运行 Token secret。它不联网、不启动服务、不部署、不读取生产数据、不发布法律页面，也不修改 production 儿童门。

## 2. 执行前硬门

任一项不明确即停止：

- 使用 S13 工具新建的数据根，SQLite、WAL、SHM 和 `.secret` 均不存在；不得把旧库、删空库、备份、快照或其他环境数据库放入该根；
- 数据根位于 canonical 仓库和生产数据根之外，专用 OS 账号、ACL/所有权、磁盘与备份边界已有批准记录；
- `SYNTHETIC_DATASET_ID`、API/法律 origin、微信 AppID/AppSecret 只属于本次独立 synthetic 候选，绝非生产资源；
- 监护关系声明和四类法律页面是获批的 synthetic 测试内容，版本、内容 SHA-256 和 canonical URL 已由责任人核对；
- 管理员标识和批准引用只描述合成对象，不含姓名、手机号、OpenID、设备标识或其他真实身份；
- 当前候选 commit 已完成安全复核；当前 S12 schema 4 artifact 锁定的 34 个实现文件与 10 个迁移精确一致；
- 操作员知道：bootstrap 成功只证明本地最小种子和回执，不证明任何外部硬门已经关闭。

不得先启动服务“让它迁移空库”。synthetic runtime 会在任何可写 SQLite 打开、迁移或 secret 创建之前要求有效且与当前环境绑定的完成回执。

## 3. 配置与一次性确认

先按 S13 手册向当前进程注入完整 S12 synthetic 配置。bootstrap 额外要求：

```text
SYNTHETIC_BOOTSTRAP_ACK=initialize-new-synthetic-database-v1
```

该确认不是秘密，只表示“本次明确初始化一个全新 synthetic SQLite”。运行服务前必须从环境中移除它。若 runtime 看到该变量或任何 `SYNTHETIC_BOOTSTRAP_PASSWORD`，会以 `SYNTHETIC_BOOTSTRAP_CONTROL_ACTIVE` 拒绝启动。

严禁设置 `SYNTHETIC_BOOTSTRAP_PASSWORD`。密码不允许通过环境变量、命令行参数、普通文件、重定向文件、剪贴板脚本、shell history、日志、截图、工单或仓库传入。

## 4. stdin 输入契约

命令不接受参数，只接受非 TTY stdin 上一个 UTF-8、最多 16 KiB 的 canonical JSON 文档。文档必须等于 `JSON.stringify` 的单行结果；只允许末尾一个 LF 或 CRLF，不允许缩进、额外空白、重复键、尾随数据或替代编码。

顶层字段固定为：

- `schemaVersion`：精确为 `1`；
- `requestId`：`synthetic-bootstrap-` 前缀的本次唯一请求标识；
- `datasetId`：精确等于 `SYNTHETIC_DATASET_ID`；
- `approvalReference`：`synthetic-approval-` 前缀的脱敏批准引用；
- `candidateProvenance`：精确包含同一次 S12 schema 4 artifact 的 `sourceCommit`、`implementationTreeSha256` 和 `configurationSha256`；三值必须机械提取，禁止手填、猜测或跨候选拼接；
- `administrator.id`：`synthetic_admin_` 前缀的合成管理员标识；
- `administrator.password`：24～128 个可打印 ASCII 字符，至少覆盖四类字符中的三类，且不得包含管理员 ID；
- `administrator.credentialPurpose`：精确为 `synthetic-only-never-production-v1`；
- `legalEvidence.effectiveAt`：不晚于执行时间的规范 ISO 时间；
- `legalEvidence.texts`：精确包含四种且各一次：`privacy_policy`、`child_personal_information_rules`、`child_user_agreement`、`sensitive_information_notice`；每项只有 `type`、以 `synthetic-` 开头的 `version` 和真实内容计算出的 64 位小写 SHA-256。

以下只是字段形状说明，故意含有无效占位符，不能直接执行，也不得把真实密码补进仓库文档：

```json
{"schemaVersion":1,"requestId":"<synthetic-bootstrap-唯一请求>","datasetId":"<与环境一致>","approvalReference":"<synthetic-approval-脱敏引用>","candidateProvenance":{"sourceCommit":"<同一 S12 artifact 的 sourceCommit>","implementationTreeSha256":"<同一 S12 artifact 的 implementationTreeSha256>","configurationSha256":"<同一 S12 artifact 的 configurationSha256>"},"administrator":{"id":"<synthetic_admin_合成标识>","password":"<由秘密管理器在内存中注入；禁止落盘>","credentialPurpose":"synthetic-only-never-production-v1"},"legalEvidence":{"effectiveAt":"<规范 ISO 时间>","texts":[{"type":"privacy_policy","version":"<synthetic-版本>","contentSha256":"<获批合成页面内容 SHA-256>"},{"type":"child_personal_information_rules","version":"<synthetic-版本>","contentSha256":"<获批合成页面内容 SHA-256>"},{"type":"child_user_agreement","version":"<synthetic-版本>","contentSha256":"<获批合成页面内容 SHA-256>"},{"type":"sensitive_information_notice","version":"<synthetic-版本>","contentSha256":"<获批合成页面内容 SHA-256>"}]}}
```

bootstrap 只校验这三个 provenance 值的格式并原样固化到不可变回执；它不会重新认证 S12 artifact，也不证明该 commit 已获外部批准。S15 Phase A 才把回执中的三值与当前已提交 HEAD、当前 S12 配置聚合和 live pristine 数据库/receipt 精确绑定。

必须由获批秘密管理器、命名管道或等价的不落盘内存生产者直接连接 stdin，再运行：

```text
npm run bootstrap:synthetic-database
```

不要使用 `< some-file.json`、`Get-Content`、`type`、`echo` 或在 shell 中拼接包含密码的 JSON。仓库不提供生成、保存或回显明文凭据的辅助脚本。

## 5. 成功结果与核对

首次成功的 `outcome` 为 `created`。至少核对：

- `purpose=synthetic_initial_bootstrap`；
- `receipt.status=completed` 且 `immutable=true`；
- `receipt.sourceCommit`、`receipt.implementationTreeSha256` 和 `receipt.preflightConfigurationSha256` 精确等于本次 S12 artifact 的三个 provenance 值；
- `administrator.role=admin`、`credentialWritten=true`；
- `legalEvidence.textCount=4`、`metadataWritten=true`；
- migration、家庭、管理员、法律元数据和回执写入数符合最小种子；
- `childOrBusinessRowsWritten=0`、`tokenSecretCreated=false`；
- `operations` 中网络、服务、子进程、部署、生产数据读取和 production 门修改均为 `false`；
- `externalHardGates` 全部仍为 `false`。

输出只可保存到获批的无秘密证据位置。保存前仍应人工搜索是否意外包含密码、管理员 ID、origin、AppID、AppSecret、绝对路径或法律正文；发现任何一项立即停止并按安全事件流程处理。

回执绑定当前 deployment 摘要、S13 marker、schema、dataset 和监护关系声明；其中任一已绑定值变化时，runtime 会以 `SYNTHETIC_BOOTSTRAP_CONTEXT_MISMATCH` 拒绝，并且不会创建 `.secret`。S14 fingerprint 不含绝对根、主机或 inode，因此相同配置与 marker 下的物理复制不保证由 S14 单独识别。S15 能阻止旧 machine subject 跨物理根复用，但在复制根上重新 capture 仍不能证明根合法，必须依赖 `filesystem_acl`、`filesystem_owner` 和 `production_root_isolation` 的外部核验。

## 6. 幂等、结果未知与后续演进

只有在“首次执行结果未知、且数据库尚未进入正常运行演进”时，才可用完全相同的 canonical 请求、完全相同的 provenance 和完全相同的密码重试：

- 已提交时返回 `outcome=replayed`；本次写入计数为 `0`，现存行计数仍为最小种子；
- 未提交且工具确认完整回滚时，工具移除本次排他创建的空 SQLite，原请求可重新 `created`；
- 请求、管理员、密码、批准引用、法律元数据或环境绑定任一变化都会拒绝；不得用新值“试探”已完成状态。

完成回执是历史事实，不是密码轮换或法律发布工具。管理员密码轮换、微信绑定、增加新法律版本、创建规则或其他正常运行状态发生后，不得再次运行 bootstrap；此时旧请求可能按 `BOOTSTRAP_CONFLICT` 或 `BOOTSTRAP_STATE_INVALID` fail closed。结果未知必须在任何后续操作前立即恢复。

进程崩溃、主机掉电、锁释放失败、无法证明事务结果或出现 WAL/SHM/未知文件时，不得猜测、删除或自动接管。停止所有相关进程，按第 8 节人工处置。

## 7. 稳定错误码

常见错误与动作：

| 错误码 | 含义与动作 |
| --- | --- |
| `ARGUMENT_INVALID` | 出现参数；移除参数，禁止把值放入 argv。 |
| `STDIN_REQUIRED` / `STDIN_TOO_LARGE` | stdin 缺失、是 TTY 或超过 16 KiB；修正受控输入通道。 |
| `BOOTSTRAP_ACK_REQUIRED` | 一次性确认缺失或不精确；重新核对授权，不得猜值。 |
| `BOOTSTRAP_SECRET_CHANNEL_INVALID` | 检测到密码环境变量；清除后改用不落盘 stdin。 |
| `BOOTSTRAP_INPUT_INVALID` | canonical JSON、字段、密码或法律元数据不满足契约。 |
| `BOOTSTRAP_DATABASE_NOT_EMPTY` | SQLite 已存在、残留 secret 或数据库不是全新路径；弃用候选根，不得删空后接管。 |
| `BOOTSTRAP_SCHEMA_INVALID` | schema 或迁移账本未知；隔离候选根。 |
| `MIGRATION_SET_INVALID` | 迁移目录与审计清单不一致；停止候选，先完成代码审查和提交。 |
| `MIGRATION_LEDGER_INVALID` | 数据库已应用迁移不是审计清单的有序前缀；隔离候选库，不得继续迁移或手改账本。 |
| `BOOTSTRAP_BUSY` | 另一 bootstrap 或残留锁存在；不得强行夺锁。 |
| `BOOTSTRAP_CONFLICT` | 已完成请求与本次输入/凭据不一致，或状态已正常演进；停止。 |
| `BOOTSTRAP_STATE_INVALID` / `BOOTSTRAP_VERIFICATION_FAILED` | 回执、最小种子、完整性或外键状态不可信；隔离并调查。 |
| `BOOTSTRAP_TRANSACTION_FAILED` | 工具确认提交前失败并完整回滚；确认无残留后才可用原输入重试。 |
| `BOOTSTRAP_RESULT_UNKNOWN` | 无法证明提交或清理结果；禁止自动重试，进入人工处置。 |
| `SYNTHETIC_DATA_ROOT_UNSAFE` | 路径、链接、文件身份、marker 或允许文件集不安全。 |
| `SYNTHETIC_BOOTSTRAP_REQUIRED` | runtime 在可写打开前发现未完成引导。 |
| `SYNTHETIC_BOOTSTRAP_CONTEXT_MISMATCH` | 回执与当前环境、marker、schema、dataset 或法律声明不绑定。 |

stderr 只应包含一个稳定码；stdout 失败时必须为空。不得把数据库异常正文、输入、路径或凭据复制到工单或聊天中。

## 8. 锁、残留与人工处置

`.synthetic-bootstrap.lock` 是排他协调文件。CLI 在 stdin 完整关闭后才获取它，避免未闭合输入长期持锁；工具绝不自动夺取或删除不属于当前文件身份的锁。

发现残留锁或未知数据库状态时：

1. 停止 bootstrap、runtime、PM2 和任何可能打开该候选 SQLite 的进程；
2. 由获批操作员核对规范路径、真实路径、普通文件类型、单链接、所有者、ACL、进程列表和时间线；
3. 保存脱敏错误码、候选 commit、Node.js 版本和时间，不保存输入或秘密；
4. 只有能证明锁完全属于已停止的本次进程，才按本地变更流程批准删除精确锁文件；
5. 只要 SQLite/WAL/SHM 的来源或提交状态不确定，就隔离整个候选根并从另一个全新 S13 根开始；不得删表、清行、VACUUM、复制数据库或手改回执以继续；
6. 若发现生产或未知数据，立即按安全事件流程处置，不得继续 bootstrap。

## 9. 完整执行顺序

1. 关闭所有 production 儿童门，保持客户端跟踪配置零联网；
2. 完成外部批准记录，但不把秘密或基础设施明文写入仓库；
3. 提交并固定候选，在该 HEAD 上运行 `npm run verify:synthetic-api-preflight`，完成提交实现和 offline guard 的内部 fixture 自检；该命令不会保留实际候选 artifact；
4. 在同一候选配置上运行 `npm run preflight:synthetic-api -- --output <系统临时目录下全新绝对目录>`，保存实际 schema 4 脱敏 artifact，并确认 34 个实现文件与 10 个迁移精确匹配；
5. 按 S13 手册 prepare 全新数据根并 verify，保存 bootstrap 前的空根 schema 1 evidence；
6. 只从第 4 步同一 S12 artifact 机械提取三个 provenance 值；
7. 通过受控进程注入完整 S12/S14 配置和不落盘 stdin，运行 bootstrap；
8. 核对脱敏 S14 schema 1 输出，立即移除 `SYNTHETIC_BOOTSTRAP_ACK`；在启动服务、登录、创建 `.secret`、绑定微信或写入业务状态前，按 S15 手册执行 Phase A capture；
9. 严格按 S15 的 19 项表（包括 DevTools 域名/TLS 校验）完成真实观察，并在 30 分钟 subject 窗口内形成未认证声明信封；
10. S15 finalize 只核验信封契约，不认证声明或授权部署。只有外部系统另行验证事实、认证责任人并签发独立部署批准后，才可执行受控 synthetic 部署；
11. 部署后仅在模拟器或成人受控设备使用 S9/S11 临时客户端做合成 E2E 和 HUKS/AssetStore smoke。

bootstrap 成功、runtime 能启动或 synthetic smoke 通过，都不是生产发布、正式法律合规、AppGallery 上架或儿童实际可用的证据。
