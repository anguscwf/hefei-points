# 糖罐积分 HarmonyOS

糖罐积分的原生 HarmonyOS 客户端工程。当前仅实现阶段 0 诊断页，用来在成人受控设备上验证启动、HTTPS、本地存储和前后台生命周期。

## 当前边界

- 版本：`0.1.0`（阶段 0 诊断版，不是面向儿童账号的业务版本）
- Bundle Name：`cn.hefeijifen.tangguan`
- 编译 SDK：HarmonyOS 6.1.1 / API 24
- 最低兼容：HarmonyOS 6.0.0 / API 20
- 设备类型：Phone
- 不连接家庭账号，不读取或修改积分
- 不申请 `MANAGE_SCREEN_TIME_GUARD` ACL
- 不启用 Push Kit 或其他无关开放能力
- 唯一网络目标：`https://hefeijifen.cn/health/live`

## 目录

- `AppScope/`：应用级资源与版本信息
- `entry/src/main/ets/pages/Index.ets`：阶段 0 诊断页
- `entry/src/main/ets/entryability/EntryAbility.ets`：浅色模式与 Ability 生命周期记录
- `entry/src/main/module.json5`：Phone 模块和 `INTERNET` 普通权限

## 构建

推荐使用 DevEco Studio 6.1.1 打开本目录并执行 Build Hap。也可安装华为官方 `@deveco/deveco-cli` 后在本目录运行：

```powershell
devecocli build clean
devecocli build --product default --modules entry@default --build-mode debug
```

未配置签名时会生成：

`entry/build/default/outputs/default/entry-default-unsigned.hap`

真机安装前需在 DevEco Studio 中登录开发者账号并配置自动调试签名。签名证书、密钥、本机路径和密码不得提交 Git。

## 真机前置检查

连接成人控制的 HarmonyOS 测试设备并确认 USB 调试授权后：

```powershell
hdc list targets
hdc shell param get const.ohos.apiversion
hdc shell param get const.product.software.version
```

首测要求设备 API 不低于 20。华为已确认实名未成年人账号不支持 AppGallery/AppTest 测试分发，因此不得通过切换账号、关闭未成年人模式或开启孩子设备开发者模式绕过限制；孩子设备只能在正式上架后从应用市场安装验收。HarmonyOS 4.2 的 MatePad 不属于本阶段首发目标，后续单独做降级兼容验证。

## 隐私说明

诊断页只保存随机诊断 ID、启动次数和用户主动写入的随机测试值；不采集设备硬件唯一标识、位置、通讯录、相册、儿童资料、家庭资料或账号凭据。剪贴板内容仅在用户点击“复制诊断结果”后写入。
