# 糖罐积分 HarmonyOS

糖罐积分的原生 HarmonyOS 儿童客户端。当前 `0.2.0 (20000)` 已实现阶段 1 / S7 的安全纵向切片：设备配对、设备会话、本人积分摘要和本人流水。它不是完整薄 MVP，也未连接任何生产或非生产业务服务。

## 当前边界

- Bundle Name：`cn.hefeijifen.tangguan`
- 编译 SDK：HarmonyOS 6.1.1 / API 24
- 最低兼容：HarmonyOS 6.0.0 / API 20
- 设备类型：Phone
- 跟踪配置固定 `NETWORK_ENABLED=false`，API 源为保留的 `.invalid` 域名；当前业务按钮在联网前置未满足时保持禁用
- 只允许设备申领/完成配对、Refresh challenge/轮换、`/api/v2/me/summary` 和 `/api/v2/me/transactions`
- 不提供家庭、儿童、设备或会话的客户端身份选择；身份只从服务端设备凭据推导
- 不申请 `MANAGE_SCREEN_TIME_GUARD` ACL，不启用照片、Push、广告、支付、第三方统计或用机兑换
- 文字积分申报暂缓：服务端尚无设备作用域的 reward-rule 读取接口，客户端不得硬编码规则或复用成人接口

## 已实现能力

- 首次输入 6 位一次性短码，生成设备公开 ID，并用 HUKS P-256 私钥完成服务端 challenge 签名
- 等待监护人在家长端二次确认，再以原 claim、签名和幂等键完成配对
- Access Token、Refresh Token、固定 Refresh 截止时间及未决写意图保存在 AssetStore；任何结果未知写入只能原字节重放
- Access 临近过期时签发设备 challenge、使用原 Refresh 凭据和设备签名完成单次轮换
- 服务端在监护授权撤回、设备/会话撤销或处理阻断时立即使凭据失效；客户端在下一次请求收到确定性 `SESSION_REVOKED` / `CONSENT_REQUIRED` 后清除本地会话并回到未配对状态
- 只在内存展示本人余额和流水；进入后台即清除业务视图
- 明确展示未配对、等待监护确认、结果未知、会话恢复、撤销和本机安全状态异常

## 安全存储与隐私

- 设备私钥由 HUKS 生成，使用 P-256 / SHA-256、禁止覆盖，并显式放在仅设备解锁时可访问的 ECE 存储级别；私钥不导出
- 会话 envelope 使用 AssetStore `DEVICE_UNLOCKED`、`REQUIRE_PASSWORD_SET=true`、`SYNC_TYPE=NEVER`、`IS_PERSISTENT=false`，更新时只按固定 alias 定位并读回核验
- 应用备份恢复关闭，备份 Extension 已移除；凭据不进入 Preferences、文件、剪贴板、日志或设备硬件标识
- 主源码不含真实手机号、AppSecret、证书、签名材料、设备标识或内嵌 Bearer
- 本地状态相位严格互斥；无关相位夹带 Token、签名或幂等意图会按损坏状态 fail closed

## 目录

- `entry/src/main/ets/config/`：默认关闭的编译时网络环境
- `entry/src/main/ets/network/`：固定设备 API、DTO 校验、稳定错误和 transport allowlist
- `entry/src/main/ets/security/`：安全随机数、HUKS 设备身份、编码与 AssetStore 会话仓
- `entry/src/main/ets/session/`：持久配对/轮换意图及 exact-replay 状态机
- `entry/src/main/ets/pages/Index.ets`：儿童端配对、余额和流水页面
- `entry/src/test/`：协议、wire contract、成功主链、跨重启恢复与撤销测试

## 本地验证

在仓库根目录执行：

```powershell
npm run check
```

只编译和运行 unsigned ArkTS 单元测试，不打包、不签名：

```powershell
$env:DEVECO_SDK_HOME='C:\Program Files\Huawei\DevEco Studio\sdk'
Set-Location .\hefei-harmonyos
& 'C:\Program Files\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.bat' `
  --mode module -p product=default -p module=entry@default -p buildMode=debug `
  test --no-daemon --no-incremental
```

S7 本地结果为 Hypium 17/17、HarmonyOS 静态安全门 7/7、ArkTS CodeLinter 0 缺陷。该结果只证明本地合成测试和 unsigned 编译，不代表 HUKS/AssetStore 真机行为、联网端到端链路、签名包或 AppGallery 包已经验证。

## 尚未满足的发布硬门

- 建立并审批独立合成非生产 API，通过受控编译时配置启用后完成联网端到端 smoke
- 在模拟器或成人受控 API 20+ 设备验证 HUKS、AssetStore、前后台、重启和清数据行为
- 补充设备作用域 reward-rule 读取 API 后，才实现文字积分申报和申请结果页面
- 完成正式法律文本、PIPIA、存量儿童数据整改、逐类留存/删除、受托方约束、密钥与加密备份演练、备案和 AppGallery 审核材料
- 使用获批 RELEASE 证书/Profile 构建候选包，并验证包结构、签名和隐私行为

实名未成年人账号不走 AppGallery/AppTest 邀请测试。不得通过侧载、切换账号、关闭未成年人模式或开启孩子设备开发者模式绕过分发限制；儿童真机安装只能在正式上架且全部生产硬门满足后验收。
