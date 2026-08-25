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

- 历史页面暂时继续使用 `app.fetchAPI`，但它只接受严格规范化的相对 `/api/...` 路径；userinfo、绝对 URL、反斜杠、双斜线、fragment 和编码路径穿越会以 `CLIENT_REQUEST_INVALID` 在本地拒绝且零请求。新增监护、设备、家庭待办和数据权利页面只能调用 `app.guardianApi`，不得自行拼接 v2 URL 或认证头。
- `app.requestV2` 只接受固定 HTTPS 源下的相对 `/api/v2/...` 路径。公开法律文本请求不发送认证头，其他家长端请求只发送成人 Bearer Token，不在 body 或 query 重复 Token。
- 只有服务端返回 `401 AUTH_REQUIRED` 且响应对应的 Token 仍是当前会话时才清除登录态。`FEATURE_DISABLED`、`FORBIDDEN_SCOPE` 和 `REAUTH_REQUIRED` 必须原样交给页面处理。
- v2 写请求不自动重试。页面应在一次用户动作开始时通过 `app.guardianApi.createIdempotencyKey(scope)` 生成密码学安全幂等键；网络失败、超时、网关 5xx 或畸形响应都按结果不确定处理，只允许用户显式复用同一个键重试。资料权利请求一旦出现未知结果便不能“放弃后换新键”，必须按持久恢复句柄向服务端对账。
- 授权建档、配对生成与资料权利请求都会在网络写入前写入经读回验证的非秘密恢复标记；标记只含操作、成人/家庭存储作用域、儿童作用域、请求类型和幂等键，不含别名、密码、重新认证断言、请求正文、短码或 challenge。应用重启后必须先用原键向服务端核对，不能静默生成新键。
- mutation 成功响应必须绑定原操作、目标资源、终态和 revision。畸形 2xx 不是成功：页面保留当前内存中的原意图与幂等键，提示结果待核对。
- 密码、重新认证断言、设备短码、挑战、公钥及任何设备会话凭据不得写入本地存储或日志。缓存用户只用于展示；家庭、儿童和监护范围始终由服务端从成人会话重新推导。
- 成人会话替换先持久化空 Token 墓碑、再写用户、最后写新 Token 并整体读回，避免存储中途失败形成跨家庭的旧 Token/新用户组合。页面订阅会话代次并丢弃旧会话迟到响应。
- `guardianApi.listChildren()` 只调用 canonical `GET /api/v2/children`，不得用旧 `/api/config`、设备列表或待办结果拼凑儿童清单。

当前 v2 客户端仅用于合成家庭的封闭验证。正式法律文本、PIPIA、存量数据整改及各项生产硬门未完成前，不得开启儿童生产功能门。

## S6/S11 封闭预发布边界

- 正式版只绑定 `https://hefeijifen.cn`，且不显示新增儿童、设备配对和家庭待办等新流程入口；公开法律文本与家庭隐私安全入口保持可发现。
- 开发版/体验版的 API 与法律源由只读代码 profile 绑定。仓库尚无已批准的独立非生产端点，因此当前 profile 指向不可路由的 `.invalid` 合成源、关闭监护预览并在本地返回 `API_ENVIRONMENT_INVALID`，不会发出 `wx.request`，更不会回退生产域。真实非生产域建立并完成微信合法域名配置前不得执行联网流程烟测。
- 查阅/导出响应只在当前页面内存中按白名单分区展示，不写文件、不写剪贴板、不进入持久缓存。安全文件交付、下载披露回执、专用限流和流式/异步大数据导出仍是生产硬门。
- 结果未知的资料权利请求只持久化最小作用域与幂等键；页面隐藏、重启或后续功能门关闭均保留标记。客户端通过 `GET /api/v2/data-rights-operations/request-create` 再读取本人请求详情，只有 child/type 精确匹配且本地标记清理读回成功后才解除新请求阻断。`not_found` 不按客户端时间自动放弃；该阻断不影响授权撤回或既有回执读取。
- 公开法律文本 `web-view` 只接受当前环境精确 origin 下 `/legal/<type>/<version>/<sha256>.html` 的叶子路径，拒绝跨类型、端口、query、fragment 与路径穿越，并用 `binderror` 清空失败 URL。正式内容不可变托管、重定向/CSP、微信 business-domain 和真机验证仍是生产硬门。
- 设备人工核对完整显示 64 位 SHA-256，每 8 位一组；无效指纹不截断展示。
- 根测试和静态扫描不能替代微信开发者工具 WXML/WXSS 编译、合法域名校验、受控成人账号设备烟测和发布审核。

S11 新增 `npm run prepare:miniapp-synthetic`，仅用于生成成人受控预发布的系统临时工程。命令要求获批的 canonical 非生产 HTTPS origin、格式正确且与跟踪工程不同的 synthetic AppID、全新系统临时输出目录，以及两项显式确认；它不会读取或复制被忽略的 `project.private.config.json`，不会连接 origin，也不会启动 DevTools、preview、upload 或部署。生成的 develop/trial profile 只指向 synthetic origin，release/unknown 固定使用不可路由源；`urlCheck` 保持开启并关闭 upload sourcemap。

生成 manifest 中“AppID 字符串不同、操作员已确认”不等于独立 AppID 已注册或当前开发者已有权限。执行真实 smoke 前仍必须外部验证 AppID provisioning、开发者授权、request 合法域名、法律 `web-view` business domain、DNS/TLS、基础设施隔离，并人工确认 DevTools 私有配置未关闭域名/TLS 校验。每次小程序跟踪源码变化后，必须重新审计并更新 S11 固定源码树摘要，不能绕过失败门。

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
utils/legacy-request-path.js        legacy 相对 API 路径规范化与 origin 防逃逸
utils/guardian-api.js               家长端 v2 端点白名单
utils/guardian-operation-recovery.js 授权写入的非秘密恢复标记
utils/device-pairing-recovery.js     配对生成的非秘密恢复标记
utils/data-rights-recovery.js        资料权利写入的非秘密恢复标记
utils/runtime-environment.js         不可运行时改写的 API/法律源 profile
utils/legal-public-url.js            法律文本 type/version/hash URL 合同
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
5. 已跟踪的 `project.config.json` 必须保持 `urlCheck: true`。被忽略的本机 `project.private.config.json` 也可能覆盖该选项；DevTools/真机烟测前必须人工确认它没有关闭域名校验，并在微信后台配置精确 HTTPS request 与 business 域名。

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
