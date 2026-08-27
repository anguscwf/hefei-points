# 受控 synthetic 数据根准备与核验

> 适用范围：阶段 1 / S13 的 synthetic 数据根准备与只读核验。
>
> 本手册不授权部署、联网、启动服务、操作生产资源或开放儿童功能。所有步骤只能由获批操作员在受控非生产环境执行。

## 1. 目的与证据边界

本流程只解决两个问题：

1. 以 fail-closed 方式创建一个全新的 synthetic 数据根、唯一 `data` 子目录和精确 marker；
2. 只读核验候选数据根的物理边界，并产生不含秘密和本机敏感路径的 schema 1 结果。

本流程不能证明 AppID 已开通、开发者已有权限、AppSecret 与生产独立、域名已配置、DNS/TLS 可用、ACL 正确、专用 OS 账号已落实、磁盘或备份已隔离、数据库只含合成数据、服务已部署，或成人设备 smoke 已通过。上述事实必须在本命令之外逐项人工核验并单独批准。

## 2. 前置人工批准

运行任何命令前，操作员必须完成并记录以下批准；任一项不明确即停止：

- 候选根是尚不存在的本机绝对路径，位于 canonical 仓库及生产数据根之外，也不是两者的父目录或子目录；
- 候选根的现存真实父目录已单独批准，且不位于网络共享、UNC、同步盘、临时映射、符号链接、junction、reparse point 或其他可重定向位置；
- 数据集标识仅对应获批合成数据，且不会与生产、真实家庭或历史备份混用；
- API origin 和微信 AppID 均属于已批准的独立 synthetic 身份，不是生产资源；
- 已指定专用 OS 账号、最小 ACL/所有权、磁盘边界、备份排除或独立备份策略、审计责任人与清理责任人；
- 已明确禁止从生产数据库、备份、日志、对象存储或密钥材料复制任何内容；
- 执行所用 Node.js 版本和 Git commit 已纳入本次候选环境记录；
- 操作员理解 prepare 只创建目录与 marker，verify 只读核验；两者均不替代外部事实核对或部署审批。

批准记录不得写入仓库，不得包含明文 origin、AppID、AppSecret、真实路径、账号名、访问令牌或其他基础设施秘密。

## 3. 显式输入

两个命令只从当前进程的显式环境变量读取完整 S12 synthetic 候选配置，不从 `.env`、用户配置、Git 配置、工作树私有文件或运行时参数猜测资源身份。操作员应通过受控秘密注入机制提供值，不得把值写入 shell 历史、普通日志、截图、工单正文或仓库文件。

完整 S12 配置包括 deployment tier、三项 synthetic 确认、API/法律源、微信应用凭据、法律证据、数据集与数据路径、功能门、配对来源策略和日志等级。本流程另外要求：

- `SYNTHETIC_DATA_ROOT_APPROVED_PARENT`：必须精确等于 `SYNTHETIC_DATA_ROOT` 的现存真实父目录；
- `SYNTHETIC_DATA_ROOT_PREPARE_ACK`：prepare 专用的逐字确认，值必须为 `prepare-new-empty-synthetic-root-v1`。

prepare 确认值不是秘密，但它只表达“操作员确认本次要创建一个全新空根”，不证明任何外部资源真实、独立或可用。verify 不得把缺少 prepare 确认误判为物理根不安全，也不得借 verify 创建或修复目录。

两个 CLI 除 `--help` 外不接受任何命令行参数，尤其不接受路径、origin、AppID 或 secret 参数。路径和资源身份只能来自显式环境；禁止通过命令行覆盖、位置参数或未知 flag 改写。

虽然完整 S12 配置包含 AppSecret，prepare/verify 不得把它写入 marker、schema 1、日志或错误信息，也不得使用生产 AppSecret。数据库内容和真实家庭数据从来都不是本流程输入。

## 4. prepare：只创建全新空根

在全部前置批准通过后运行：

```text
npm run prepare:synthetic-data-root
```

prepare 的成功行为必须严格限制为：

1. 重新核对完整 S12 配置、批准父目录、prepare 确认和路径形态；
2. 以排他方式创建此前不存在的根目录；
3. 在根目录下创建唯一的 `data` 子目录；
4. 以排他方式写入精确 marker；
5. 在返回成功前重新只读核验目录、marker 和文件类型。

成功后的根目录只能包含 marker 和 `data`；新建的 `data` 必须为空。prepare 不得创建或打开 SQLite，不得生成 Token secret，不得读取数据库，不得联网，不得启动服务，不得调用微信开发者工具，不得 preview/upload，不得部署，也不得修改任何儿童功能门。

marker 只允许包含运行契约需要的 schema、用途、合成数据集标识、API origin 摘要、微信 AppID 摘要和固定相对文件位置。它不得包含明文 origin、明文 AppID、AppSecret、绝对路径、OS 账号、ACL、数据库内容或任何个人信息。

如果候选根已经存在，即使它看起来为空或由上一次失败留下，prepare 也必须拒绝。禁止自动接管、合并、覆盖、补写、清空或删除既有目录。

## 5. verify：只读、脱敏的 schema 1 核验

对已准备的候选根运行：

```text
npm run verify:synthetic-data-root
```

verify 必须保持只读。它不得创建、删除、重命名、修复或改写根、`data`、marker、数据库、WAL/SHM、secret 或任何父目录；也不得启动服务、打开 SQLite 连接、联网或触发部署。

核验至少覆盖：

- 输入路径是规范化本机绝对路径，批准父目录精确等于候选根的现存真实父目录，并满足与仓库、生产数据根隔离的形态约束；
- 工具通过 `lstat` 与 `realpath` 拒绝可检测的符号链接、junction 和路径重定向；其他 Windows reparse 类型及同权限写入者造成的瞬态替换仍须由操作员在外部核验，不能从本结果推断为安全；
- 根和 `data` 的真实路径与声明路径完全一致；
- 根目录只有精确 marker 和唯一 `data` 子目录；
- marker 是普通单链接文件，字节内容与候选配置重新计算的期望值完全一致；
- `data` 是普通目录；准备后为空，运行后也只能包含运行契约明确允许的固定 SQLite、WAL、SHM 和 secret 普通单链接文件；
- 未出现额外文件、目录、链接、设备文件或路径别名。

成功输出是脱敏 schema 1 结果，只能表达 `configuration`、`filesystem`、`externalVerification`、`operations` 和 `productionChildGate` 等类别的结构校验结论、必要摘要和未验证状态。输出不得包含明文 origin、明文 AppID、AppSecret、绝对路径、marker 正文、数据库正文、账号名、ACL 明细或个人信息。schema 1 成功只代表“当前读取到的数据根结构符合本地契约”，不代表其来源可信、内容合规或适合部署。

## 6. `external=false` 的准确含义

schema 1 中所有外部核验项必须保持 `false`。这些值不能由 prepare 或 verify 改成 `true`，也不能由操作员口头确认后手改结果。

### 6.1 “未由本命令核验”的外部事实

以下 `externalVerification` 字段为 `false` 时，准确含义是“prepare/verify 没有能力核验该事实”，而不是“该条件已满足”，也不一定表示该条件事实上不存在：

- `appIdProvisioningVerified`：没有核验 AppID 已在平台开通；
- `developerAuthorizationVerified`：没有核验当前开发者账号与权限；
- `appSecretIndependenceVerified`：没有核验 AppSecret 的来源、托管、轮换及与生产隔离；
- `requestDomainVerified`：没有核验 request domain 平台配置；
- `businessDomainVerified`：没有核验 business domain 平台配置；
- `dnsVerified`：没有执行或核验 DNS 解析；
- `tlsVerified`：没有核验证书链、协议配置或实际 TLS 行为；
- `osAccountVerified`：没有核验专用 OS 账号存在或服务实际运行身份；
- `aclVerified`：没有核验平台 ACL、继承规则和有效访问主体；
- `ownerVerified`：没有核验获批所有者及其权限边界；
- `diskIsolationVerified`：没有核验物理卷、快照、复制或存储边界；
- `backupIsolationVerified`：没有核验备份计划、排除规则、恢复源或到期清理；
- `databaseContentVerified`：没有打开 SQLite，也没有核验数据库内容和来源；
- `infrastructureConnectivityVerified`：没有核验端口、代理、边缘或基础设施实际连通；
- `legalRecordsVerified`：没有核验法律页面、版本、摘要、重定向或 CSP 的发布状态；
- `productionRootIsolationVerified`：只检查候选路径形态，没有读取或识别真实生产数据根，不能证明实际隔离。

这些项目必须由对应系统的权威界面、配置、受控探测或人工复核提供独立证据，不能从目录形态或摘要反推。

### 6.2 “本次命令没有执行”的动作

`operations` 中 `deploymentPerformed`、`databaseOpened`、`networkAccessPerformed`、`serverStarted`、`subprocessStarted`、`devToolsInvoked`、`previewOrUploadPerformed`、`adultDeviceSmokeVerified` 和 `huksAssetStoreRuntimeVerified` 为 `false` 时，准确含义仅是“本次 prepare/verify 没有执行对应动作或验证”。它不证明其他进程、其他会话或历史操作从未执行过，也不证明部署现场当前状态安全。

`productionChildGate.deployedStateVerified=false` 表示本命令没有读取部署现场；`productionChildGate.changeAttempted=false` 只表示本命令没有尝试改门。二者都不能作为 production 儿童门当前确实关闭的证据，部署前仍须由获权操作员在部署现场单独核对。

## 7. 外部硬门清单

数据根 verify 成功后，仍须逐项关闭以下硬门；全部完成前不得审批 synthetic 部署：

1. **资源身份**：独立 synthetic AppID 已开通，开发者权限有效，AppSecret 独立生成、托管和轮换，且未使用生产身份或密钥。
2. **域名与网络**：API/法律源、request/business domain、DNS、TLS、证书链、重定向和 CSP 已按真实平台配置核验；没有访问生产 host 的回退路径。
3. **OS 与权限**：专用 OS 账号真实存在，服务进程确实以该身份运行；根、父目录、数据库和 secret 的 ACL/所有权满足最小权限且无意外继承。
4. **磁盘与备份**：存储位置、快照、复制、备份、恢复和到期清理与生产隔离；不会被通用生产备份任务收集，也不会把生产备份恢复进 synthetic 根。
5. **数据库内容**：初始数据库为空或只含批准的合成家庭；已检查数据库、WAL、SHM、导入来源和迁移输入，不含生产数据、备份、日志、真实手机号、设备标识或凭据。
6. **基础设施**：端口、反向代理、可信代理范围、边缘限流、最小监控、日志等级、审计和清理责任经过批准；日志不记录秘密或儿童敏感正文。
7. **运行线与预检**：批准的 Node.js 运行线与仓库声明一致；候选已提交 commit 上的 S12 preflight 通过，当前 schema 4 证据无秘密且仍把外部事实如实标为未验证。
8. **独立审批**：只有数据根、外部清单和 S12 preflight 均通过，才可由有权人员另行批准一次受控 synthetic 部署。

任何一项只能由受权人员依据实际证据关闭。不得把 schema 1、schema 4、摘要相等、配置字符串形态正确或命令退出码为零当成外部硬门已通过。

## 8. 禁止事项

- 禁止使用生产 origin、AppID、AppSecret、Token secret、数据库、备份、日志、账号、设备标识或其他生产资源；
- 禁止把真实家庭或儿童数据复制、导入、恢复或手工录入 synthetic 根；
- 禁止把候选配置、marker、证据或故障日志中的敏感值提交到 Git；
- 禁止由 prepare/verify 启动服务、部署、联网、调用 DevTools、preview/upload 或操作远端平台；
- 禁止修改跟踪的 HarmonyOS/小程序零联网默认配置，禁止运行时改源或允许访问生产 host；
- 禁止打开 production 儿童功能门，禁止把 synthetic 门配置复制到 production tier；
- 禁止把目录核验通过解释为法律、PIPIA、存量整改、备案、AppGallery 或儿童可用条件已经满足；
- 禁止侧载到儿童设备、切换儿童账号、关闭未成年人模式、开启孩子设备开发者模式或采用其他绕过正式分发的路线。

## 9. 失败与残根人工处置

### 9.1 prepare 失败或中断

1. 立即停止，不在同一路径重跑 prepare；
2. 只记录脱敏错误类别、候选 commit、Node.js 版本和时间，不记录真实路径或资源值；
3. 将候选路径视为“不可信残根”，不得启动服务、写数据库、生成 secret 或用于下一次 prepare；
4. 由获权操作员在同一受控主机上确认目标的规范化路径、真实路径、所有权、链接状态和内容；
5. 若发现未知内容、生产数据或无法证明来源的文件，立即隔离并按安全事件流程处理，不得直接删除；
6. 只有在操作员确认该残根完全归属于本次失败、没有生产或未知内容，并按本地变更流程批准后，才可人工删除；prepare/verify 不提供自动清理或接管；
7. 后续重试使用另一个全新、重新批准且尚不存在的根。

### 9.2 verify 失败

1. 停止后续预检、部署和 smoke，不运行 prepare 修补既有根；
2. 保存脱敏失败类别，不手改 marker、目录结构、权限或输出以“让验证通过”；
3. 若该根已被某个受控 synthetic 服务使用，由获权操作员按运行手册停止相关服务并保留必要证据；本命令不负责停止进程；
4. 人工核对路径漂移、链接/reparse、额外文件、marker 不一致、权限变化和并发写入来源；
5. 无法证明安全来源时弃用并隔离该根，重新从全新批准根开始；不得复制可疑数据库或 secret 到新根。

## 10. 完整执行顺序

1. 完成并留存不入库的人工批准记录，提交并固定候选；
2. 注入同一套完整 S12 配置，运行 `npm run verify:synthetic-api-preflight` 完成提交实现和 offline guard 的内部 fixture 自检；该命令不会保留实际候选 artifact；
3. 运行 `npm run preflight:synthetic-api -- --output <系统临时目录下全新绝对目录>`，保存实际候选 schema 4 artifact；
4. 通过受控方式向当前进程继续注入相同配置、批准父目录和 prepare 确认，运行 `npm run prepare:synthetic-data-root`；
5. 在 prepare 成功后单独运行 `npm run verify:synthetic-data-root`；
6. 人工核对脱敏 schema 1，并确认所有 `external=false` 仍被当作未关闭硬门；
7. 按 S14 手册只从第 3 步 artifact 机械提取 provenance 并 bootstrap；在任何运行状态演进前按 S15 capture；
8. 严格按 S15 的 19 项表完成 AppID、域名、DNS/TLS、账号/ACL、磁盘/备份、数据库、DevTools 域名/TLS、生产根隔离等真实观察，再封装未认证声明；
9. S15 finalize 不验证身份或外部事实。只有外部系统完成认证并签发独立部署授权后，才执行受控 synthetic 部署；
10. 部署后仅使用受控临时客户端工程，在模拟器或成人受控设备完成 synthetic E2E 与 HUKS/AssetStore smoke；
11. 所有生产儿童门继续保持关闭，直到总体方案中的工程、合规、数据、备案、审核和发布硬门全部关闭。

prepare 成功、verify 成功或 synthetic smoke 成功，都不是生产部署、正式发布或儿童可用的证据。
