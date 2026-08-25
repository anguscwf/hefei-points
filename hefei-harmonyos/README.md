# 糖罐积分 HarmonyOS

糖罐积分的原生 HarmonyOS 儿童客户端。当前 `0.2.0 (20000)` 已实现阶段 1 / S9 的合成端到端就绪切片：设备配对、设备会话、本人积分摘要/流水、当前可申报规则、文字积分申报和“我的申请”，以及受控临时 synthetic profile。它不是完整薄 MVP，也未连接任何外部生产或非生产业务服务。

## 当前边界

- Bundle Name：`cn.hefeijifen.tangguan`
- 编译 SDK：HarmonyOS 6.1.1 / API 24
- 最低兼容：HarmonyOS 6.0.0 / API 20
- 设备类型：Phone
- 跟踪配置固定 `NETWORK_ENABLED=false`，API 源为保留的 `.invalid` 域名；当前业务按钮在联网前置未满足时保持禁用
- 只有获批独立 synthetic HTTPS 源后，才允许用仓库根的生成器创建位于系统临时目录、明确 unsigned 的 `synthetic-approved` 副本；生成器不改跟踪源码、不读取私有根构建配置，也不发起网络请求
- transport 只允许设备申领/完成配对、Refresh challenge/轮换、本人摘要/流水、设备 reward rules，以及本人积分申请创建/列表的固定方法与路径
- 不提供家庭、儿童、设备或会话的客户端身份选择；身份只从服务端设备凭据推导
- 不申请 `MANAGE_SCREEN_TIME_GUARD` ACL，不启用照片、Push、广告、支付、第三方统计或用机兑换
- 不实现申请补充、取消或重新提交：当前设备契约尚不能可靠取得单条详情并对账这些写操作，禁止用结果猜测替代精确恢复

## 已实现能力

- 首次输入 6 位一次性短码，生成设备公开 ID，并用 HUKS P-256 私钥完成服务端 challenge 签名
- 等待监护人在家长端二次确认，再以原 claim、签名和幂等键完成配对
- Access Token、Refresh Token、固定 Refresh 截止时间及未决写意图保存在 AssetStore；任何结果未知写入只能原字节重放
- Access 临近过期时签发设备 challenge、使用原 Refresh 凭据和设备签名完成单次轮换
- 服务端在监护授权撤回或设备/会话撤销时立即使凭据失效；客户端在下一次请求收到确定性 `SESSION_REVOKED` / `CONSENT_REQUIRED` 后先清未决积分意图、再清本地会话并回到未配对状态。`CHILD_PROCESSING_BLOCKED`、`CHILD_DATA_INCOMPLETE` 或功能门关闭只清内存业务视图，并保留会话和原未决意图等待安全恢复
- 只读取当前设备作用域内可申报的鼓励规则，选择积分并提交不超过 120 字的单行说明
- 在发送创建请求前，把规范化请求体、原幂等键和设备绑定写入独立 AssetStore；结果未知或重启时先按 `clientRequestId` 对账，未找到才精确重放原请求
- 只在内存展示本人余额、流水、规则和申请状态；进入后台即清除业务视图与草稿
- 明确展示未配对、等待监护确认、结果未知、会话恢复、撤销和本机安全状态异常

## 安全存储与隐私

- 设备私钥由 HUKS 生成，使用 P-256 / SHA-256、禁止覆盖，并显式放在仅设备解锁时可访问的 ECE 存储级别；私钥不导出
- 会话 envelope 和积分申请意图分别使用固定 alias 的 AssetStore `DEVICE_UNLOCKED`、`REQUIRE_PASSWORD_SET=true`、`SYNC_TYPE=NEVER`、`IS_PERSISTENT=false` 记录，更新时读回核验；撤权清理必须先清申请意图再清会话
- 应用备份恢复关闭，备份 Extension 已移除；凭据不进入 Preferences、文件、剪贴板、日志或设备硬件标识
- 主源码不含真实手机号、AppSecret、证书、签名材料、设备标识或内嵌 Bearer
- 本地状态相位严格互斥；无关相位夹带 Token、签名或幂等意图会按损坏状态 fail closed

## 目录

- `entry/src/main/ets/config/`：默认关闭的编译时网络环境
- `entry/src/main/ets/network/`：固定设备 API、DTO 校验、稳定错误和 transport allowlist
- `entry/src/main/ets/security/`：安全随机数、HUKS 设备身份、编码、AssetStore 会话仓与积分申请意图仓
- `entry/src/main/ets/session/`：持久配对/轮换/申报意图及 exact-replay 状态机
- `entry/src/main/ets/pages/Index.ets`：儿童端配对、余额、流水、文字申报和本人申请页面
- `entry/src/test/`：协议、wire contract、成功主链、跨重启恢复与撤销测试

## 本地验证

在仓库根目录执行：

```powershell
npm run check
```

独立 synthetic 源获批后，可生成受控临时编译副本；下面的命令只准备工作区，不联网、不安装依赖、不打包、不签名：

```powershell
$syntheticParent = Join-Path ([IO.Path]::GetTempPath()) `
  ("tangguan-synthetic-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $syntheticParent | Out-Null
npm run prepare:harmonyos-synthetic -- `
  --origin https://approved-synthetic.example.com `
  --output (Join-Path $syntheticParent 'harmony') `
  --acknowledge-approved-synthetic-origin
```

只编译和运行 unsigned ArkTS 单元测试，不打包、不签名：

```powershell
$env:DEVECO_SDK_HOME='C:\Program Files\Huawei\DevEco Studio\sdk'
Set-Location .\hefei-harmonyos
& 'C:\Program Files\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.bat' `
  --mode module -p product=default -p module=entry@default -p buildMode=debug `
  test --no-daemon --no-incremental
```

S9 本地结果为根级 `npm test` 199/199、S9 定向回归 16/16、HarmonyOS 静态安全门 10/10，以及来自干净提交的临时 unsigned profile Hypium 39/39。S9 没有把 CodeLinter 计为有效新证据：本机 CLI 无法解析已安装的 HarmonyOS SDK；S8 的 0 缺陷记录仅是历史结果，发布候选前须修复工具链并重跑。以上结果只证明 loopback 合成链路、静态门和 unsigned 编译，不代表 HUKS/AssetStore 真机行为、外部联网端到端链路、签名包或 AppGallery 包已经验证。

## 尚未满足的发布硬门

- 建立并审批物理、域名、凭据和数据均独立的合成非生产 API，使用受控临时 profile 完成联网端到端 smoke；当前生成器就绪不等于该 API 已存在
- 修复本机 CodeLinter SDK 解析并对最终 ArkTS 主源码重跑 0 缺陷门
- 在模拟器或成人受控 API 20+ 设备验证 HUKS、AssetStore、前后台、重启和清数据行为
- 在设备作用域单条详情和写操作对账契约完成前，继续关闭申请补充、取消与重新提交；同时明确未决文字的保留期限及监护人授权安全放弃流程
- 完成儿童易懂版隐私摘要、设置、审核测试家庭和成人预验收核心闭环
- 完成正式法律文本、PIPIA、存量儿童数据整改、逐类留存/删除、受托方约束、密钥与加密备份演练、备案和 AppGallery 审核材料
- 使用获批 RELEASE 证书/Profile 构建候选包，并验证包结构、签名和隐私行为

实名未成年人账号不走 AppGallery/AppTest 邀请测试。不得通过侧载、切换账号、关闭未成年人模式或开启孩子设备开发者模式绕过分发限制；儿童真机安装只能在正式上架且全部生产硬门满足后验收。
