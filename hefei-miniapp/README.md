# 糖罐积分微信小程序

本目录是糖罐积分的微信小程序家长端。canonical 基线沿用已提交的 v2.5 客户端语义，不接受旧父仓对工作树造成的 v2.1/v2.4 覆盖。

## 当前能力

- 家庭成员与角色化首页；
- 积分记分、流水和成长报表；
- 家庭规则读取、管理、revision 冲突保护和历史恢复入口；
- 稳定 `ruleId` / `categoryId` 透传，使规则改名后仍可追溯流水；
- 家长端 v2 请求、稳定错误结果、幂等键和会话失效基座；
- 头像、主题和常用管理入口。

服务端继续兼容不携带稳定规则 ID 的旧客户端，但新代码不得主动退回该降级路径。

## v2 请求边界

- 历史页面暂时继续使用 `app.fetchAPI`；新增监护、设备、家庭待办和数据权利页面只能调用 `app.guardianApi`，不得自行拼接 v2 URL 或认证头。
- `app.requestV2` 只接受固定 HTTPS 源下的相对 `/api/v2/...` 路径。公开法律文本请求不发送认证头，其他家长端请求只发送成人 Bearer Token，不在 body 或 query 重复 Token。
- 只有服务端返回 `401 AUTH_REQUIRED` 且响应对应的 Token 仍是当前会话时才清除登录态。`FEATURE_DISABLED`、`FORBIDDEN_SCOPE` 和 `REAUTH_REQUIRED` 必须原样交给页面处理。
- v2 写请求不自动重试。页面应在一次用户动作开始时通过 `app.guardianApi.createIdempotencyKey(scope)` 生成密码学安全幂等键；网络失败、超时、网关 5xx 或畸形响应都按结果不确定处理，只允许用户显式复用同一个键重试，或放弃后先刷新服务端状态。
- 密码、重新认证断言、设备短码、挑战、公钥及任何设备会话凭据不得写入本地存储或日志。缓存用户只用于展示；家庭、儿童和监护范围始终由服务端从成人会话重新推导。
- `guardianApi.listChildren()` 只调用 canonical `GET /api/v2/children`，不得用旧 `/api/config`、设备列表或待办结果拼凑儿童清单。

当前 v2 客户端仅用于合成家庭的封闭验证。正式法律文本、PIPIA、存量数据整改及各项生产硬门未完成前，不得开启儿童生产功能门。

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
node --check components/action-sheet/action-sheet.js
node --check pages/admin/admin.js
node --check pages/index/index.js
node --check pages/mine/mine.js
node --check pages/report/report.js
```

并在微信开发者工具中编译，检查登录/退出、首页记分、规则历史、管理页、报表及主题切换。根目录 `npm test` 只覆盖服务端和共享质量门，不能替代 WXML/WXSS 编译与真机烟测。
