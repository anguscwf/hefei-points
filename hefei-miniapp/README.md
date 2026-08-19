# 糖罐积分微信小程序

本目录是糖罐积分的微信小程序家长端。canonical 基线沿用已提交的 v2.5 客户端语义，不接受旧父仓对工作树造成的 v2.1/v2.4 覆盖。

## 当前能力

- 家庭成员与角色化首页；
- 积分记分、流水和成长报表；
- 家庭规则读取、管理、revision 冲突保护和历史恢复入口；
- 稳定 `ruleId` / `categoryId` 透传，使规则改名后仍可追溯流水；
- 头像、主题和常用管理入口。

服务端继续兼容不携带稳定规则 ID 的旧客户端，但新代码不得主动退回该降级路径。

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
```

## 本地开发

1. 使用微信开发者工具导入本目录；
2. `project.config.json` 可提交，`project.private.config.json` 是本机私有设置并被 Git 忽略；
3. AppSecret 只允许由服务端环境变量提供，不能写入小程序源码或项目配置；
4. 调试与验收必须使用合成家庭/账号，不得污染真实家庭数据。

提交前至少执行：

```powershell
node --check app.js
node --check components/action-sheet/action-sheet.js
node --check pages/admin/admin.js
node --check pages/index/index.js
node --check pages/mine/mine.js
node --check pages/report/report.js
```

并在微信开发者工具中编译，检查登录/退出、首页记分、规则历史、管理页、报表及主题切换。根目录 `npm test` 只覆盖服务端和共享质量门，不能替代 WXML/WXSS 编译与真机烟测。
