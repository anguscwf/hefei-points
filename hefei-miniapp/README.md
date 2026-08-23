# 糖罐积分微信小程序

本目录是糖罐积分的微信小程序家长端。canonical 基线沿用已提交的 v2.5 客户端语义，不接受旧父仓对工作树造成的 v2.1/v2.4 覆盖。

## 当前能力

- 家庭成员与角色化首页；
- 积分记分、流水和成长报表；
- 家庭规则读取、管理、revision 冲突保护和历史恢复入口；
- 稳定 `ruleId` / `categoryId` 透传，使规则改名后仍可追溯流水；
- 家长端 v2 请求、稳定错误结果、幂等键和会话失效基座；
- 监护授权/重新授权向导、四类公开法律文本与监护关系声明的逐项确认；
- 设备配对生成、家长二次确认、设备/会话撤销与非秘密恢复标记；
- 家庭待办汇总、筛选、详情、退回补充、批准和驳回；
- 家庭与隐私中的授权撤回、查阅/导出、更正、删除和终止服务入口；
- 头像、主题和常用管理入口。

服务端继续兼容不携带稳定规则 ID 的旧客户端，但新代码不得主动退回该降级路径。

## v2 请求边界

- 历史页面暂时继续使用 `app.fetchAPI`；新增监护、设备、家庭待办和数据权利页面只能调用 `app.guardianApi`，不得自行拼接 v2 URL 或认证头。
- `app.requestV2` 只接受固定 HTTPS 源下的相对 `/api/v2/...` 路径。公开法律文本请求不发送认证头，其他家长端请求只发送成人 Bearer Token，不在 body 或 query 重复 Token。
- 只有服务端返回 `401 AUTH_REQUIRED` 且响应对应的 Token 仍是当前会话时才清除登录态。`FEATURE_DISABLED`、`FORBIDDEN_SCOPE` 和 `REAUTH_REQUIRED` 必须原样交给页面处理。
- v2 写请求不自动重试。页面应在一次用户动作开始时通过 `app.guardianApi.createIdempotencyKey(scope)` 生成密码学安全幂等键；网络失败、超时、网关 5xx 或畸形响应都按结果不确定处理，只允许用户显式复用同一个键重试，或放弃后先刷新服务端状态。
- 授权建档与配对生成会先写入经读回验证的非秘密恢复标记；标记只含操作、儿童作用域和幂等键，不含别名、密码、重新认证断言、短码或 challenge。应用重启后必须先用原键向服务端核对，不能静默生成新键。
- mutation 成功响应必须绑定原操作、目标资源、终态和 revision。畸形 2xx 不是成功：页面保留当前内存中的原意图与幂等键，提示结果待核对。
- 密码、重新认证断言、设备短码、挑战、公钥及任何设备会话凭据不得写入本地存储或日志。缓存用户只用于展示；家庭、儿童和监护范围始终由服务端从成人会话重新推导。
- 成人会话替换先持久化空 Token 墓碑、再写用户、最后写新 Token 并整体读回，避免存储中途失败形成跨家庭的旧 Token/新用户组合。页面订阅会话代次并丢弃旧会话迟到响应。
- `guardianApi.listChildren()` 只调用 canonical `GET /api/v2/children`，不得用旧 `/api/config`、设备列表或待办结果拼凑儿童清单。

当前 v2 客户端仅用于合成家庭的封闭验证。正式法律文本、PIPIA、存量数据整改及各项生产硬门未完成前，不得开启儿童生产功能门。

## S6 封闭预发布边界

- 正式版不显示新增儿童、设备配对和家庭待办等新流程入口；公开法律文本与家庭隐私安全入口保持可发现。开发版/体验版入口仍受服务端全部功能门约束。
- 当前 API 基址固定为生产域名；在建立编译时绑定、不可由客户端改写的合成非生产端点，并让预览模式拒绝生产 host 之前，不得用开发版/体验版执行联网流程烟测。
- 查阅/导出响应只在当前页面内存中按白名单分区展示，不写文件、不写剪贴板、不进入持久缓存。安全文件交付、下载披露回执、专用限流和流式/异步大数据导出仍是生产硬门。
- 结果未知的普通数据行权请求目前可在页面放弃或随页面隐藏而清除内存意图；生产前应增加非秘密 durable 恢复句柄和服务端对账，避免使用新键产生重复请求/审计记录。
- 公开法律文本 `web-view` 生产前必须限定正式域名与路径并补加载失败处理；设备人工核对指纹也应展示更长的分组值。
- 根测试和静态扫描不能替代微信开发者工具 WXML/WXSS 编译、合法域名校验、受控成人账号设备烟测和发布审核。

## 主要入口

```text
app.js                              全局配置、登录状态与主题
pages/index/                        首页、积分与规则入口
pages/admin/                        家庭和规则管理
pages/report/                       报表与筛选
pages/records/                      流水记录
pages/rule-history/                 规则版本历史
pages/mine/                         我的与设置
components/action-sheet/            记分操作面板
utils/rules-view-model.js           规则展示与兼容视图模型
utils/session.js                    登录态恢复、提交与清理
utils/v2-request.js                 严格 v2 HTTPS 传输与稳定结果
utils/guardian-api.js               家长端 v2 端点白名单
utils/guardian-operation-recovery.js 授权写入的非秘密恢复标记
utils/device-pairing-recovery.js     配对生成的非秘密恢复标记
pages/guardian-consent/              授权建档与重新授权
pages/device-management/             配对确认、设备与会话撤销
pages/family-tasks/                  家庭待办与单条审批
pages/family-privacy/                授权历史与儿童数据权利
pages/legal-document/                常驻公开法律文本入口
```

## 本地开发

1. 使用微信开发者工具导入本目录；
2. `project.config.json` 可提交，`project.private.config.json` 是本机私有设置并被 Git 忽略；
3. AppSecret 只允许由服务端环境变量提供，不能写入小程序源码或项目配置；
4. 调试与验收必须使用合成家庭/账号，不得污染真实家庭数据。
5. `project.config.json` 的 `urlCheck: false` 只用于本地开发便利，不是发布绕过；发布前仍须在微信后台配置合法的 HTTPS request 域名并开启域名校验。

提交前至少执行：

```powershell
node --check app.js
node --check utils/session.js
node --check utils/v2-request.js
node --check utils/guardian-api.js
node scripts/check-miniapp.js
node --check components/action-sheet/action-sheet.js
node --check pages/admin/admin.js
node --check pages/index/index.js
node --check pages/mine/mine.js
node --check pages/report/report.js
```

并在微信开发者工具中编译，检查登录/退出、首页记分、规则历史、管理页、报表及主题切换。根目录 `npm test` 只覆盖服务端和共享质量门，不能替代 WXML/WXSS 编译与真机烟测。
