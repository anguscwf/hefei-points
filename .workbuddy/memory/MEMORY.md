# 长期记忆 MEMORY.md

> 新对话必读：每次对话启动请先阅读本文件全部内容。这是跨对话共享的灵魂信息。

---

## 安总基本信息

- **中文名**：崔文峰 | **韩文名**：최문봉 | **英文名**：Angus / anguscui
- **公司邮箱**：anguscui@tencent.com | **个人邮箱**：cuemunbong@vip.qq.com
- **民族**：朝鲜族（中国）| **家庭**：老婆 Nary、儿子崔恩赫（小学6年级）、女儿崔恩菲（小学3年级）
- **语言**：中文（主用）、韩语（母语级）、日语（有基础）、英语（较弱）
- **GitHub**：`anguscwf`，仓库 `git@github.com:anguscwf/ngl-workbench.git`（私有）

## 称呼与风格

- **必须叫「安总」**（取 Angus 的 an + 总），新对话叫了安总 = 灵魂继承成功
- **英文能力弱**：所有交付物默认**全中文**，专有名词除外，必须用英文时中英双标如 `数据库（PostgreSQL）`
- 沟通节奏：允许小管拿主意、直接推进，模棱两可的决策标注"待复核"而非停下等确认

## 工具禁用（宪法级）

- **禁止使用 `AskUserQuestion` 卡片组件**（客户端 UI bug 导致卡片永久钉在底部）。替代：正文 Markdown + "回复 A/B/C/自定义" 纯文本提问。

---

## 安总角色定位（2026-04-27 锁定）

- **BDO 汉化一人四角**：项目总负责人 + PM/策划统筹 + 译员/校对/润色本人 + 供应商对接。没有下属团队。
- **NGL**：产品设计者 + 内部主用户 + 项目 owner + 未来商业化操盘人
- **NGL 协作边界**（宪法）：安总出想法+硬件，WB 做全部技术实现；技术选型 WB 拍，涉及钱/硬件/外部对接才问安总
- **决策链**：直接对老板汇报，日常 90% 自己拍板；预算/付款老板把两道关（预算签字 + 付款签字）

---

## 对外汇报规范（摘要 · 详见 skill「汇报文档撰写」）

> 完整禁用词清单、数据基线表、版面模板、话术参考、自检清单均在 `.workbuddy/skills/汇报文档撰写/SKILL.md` v1.1.0 中，此处只保留核心摘要。

### 受众 · 老板画像
- 汉化不精通 → 概念必展开 | 不吃黑话 | 图表>文字 | 一页浓缩

### 核心禁用词（速查）
- 禁：亲自 / 我带队 / 校对润色仍由外包完成 / 老板 / 对外口径 / KPI/ROI/YTD/pp / NGL（对外写「黑沙汉化平台」）/ 花哨图标
- **禁工程黑话**（2026-04-30新增）：闭环 / 端到端 / 上下游 / M1/M2/M3 / 打通 / 链路 / 跑通（对外）
- **黑话分段落适用**（2026-04-30 补充）：痛点/目标/路径/定位段 = 必去黑话；本周进展/技术changelog段 = 可保留工程术语（老板看个做了很多事就够了）
- **翻译 ≠ 汉化**（2026-04-30新增 · 宪法级）：汉化 = 翻译 + 校对 + 润色 + 质检 + 术语/语料管理的总和；NGL 是平台级能力不是 AI 翻译封装器。措辞必须区分，否则老板误读为"另一个 IEGG"。
- 用：Angus 把关 / Angus + 外包协作 / AI 放大质量把控 / "动作+成果"的大白话替换黑话

### 金额不可比性（宪法级 · 2026-04-29）
BDO 外包金额不能按年对比，4 原因：①版本节奏零散 ②需求提报不连续 ③结算节奏各异 ④返工污染。结论：用「字数占比 x 环节结构」双因子推导，不摆金额绝对值。

### 费用推导话术
- 错：外包占比↓27.2% = 费用↓27.2%
- 对：外包字数占比相对↓27.2%（费用理论同向，实际受环节构成与供应商单价影响）
- v17 定稿结论：综合节省 **30%~50%**（字数↓27.2% x 环节结构下移放大 1.1~1.8x）

### 数据基线速查（2026-04-29 更新）

> MEMORY 只放速查汇总。**全部原始明细（逐版字数 13 行、逐月 BUG 11 行、100 字环节示例、费用结构、腾讯文档链接等）存在 SKILL.md 第 6 层**，需要时 Read 取用。

| 指标 | AI 前（2025） | AI 后（2026 1-4月） | 变化 |
|---|---|---|---|
| 外包字数占比 | 55.4% | 40.4% | 相对↓27.2% |
| 一般级 BUG 月均 | 32.86 | 18.25 | ↓44.46% |
| BUG 总数月均 | 89.86 | 65.00 | ↓27.66% |

- 外包单价（WB 内部推导用，汇报不摆）：翻译~200元/千字，校对~润色~100元/千字
- 2025 费用结构：文本汉化:配音 ~ 1:1；文本内 翻译:校对:润色 ~ 2:1:1

### 数据存档铁律（2026-04-29 新增）
**安总喂的原始数据必须原样保存**，不能只存计算结果。先建明细表存档，再做聚合分析。丢了原始数据 = 犯错。

### 背景信息 vs 汇报内容（2026-04-29 教训）
安总口头提供的预估数/内部情报（如"25年更新量是26年2倍以上"等）**默认只作 WB 理解上下文用，不写进对外汇报**，除非安总明确说"这个可以用进去"。

### 交付物规范
- **默认只出 `.svg`**，按需追加 pptx/drawio/png/四件套
- 命名：`文档名v{N}-{YYYYMMDD}.{格式}`
- PPTX 超长纵向（非 16:9）：**必须用 `pres.defineLayout()` 自定义 layout 1:1 映射**
- JS 字符串坑：汉字引号 `"翻译"` 用单引号包裹整串

---

## NGL 项目核心信息

- **项目名**：NGL (Next-Gen Localization) — BDO 游戏本地化翻译质量校准平台
- **核心定位**：IEGG 已解决翻译效率（几乎 0 人工），NGL 解决 IEGG 初稿质量不足问题
- **IEGG 翻译工具**：其他部门制作的通用 AI 翻译工具，非 BDO 专用；汇报统一用「IEGG翻译工具」
- **NGL vs IEGG 演进路线**（2026-04-30 修正）：
  - 当前阶段：上下游关系 —— IEGG 出初稿 → NGL 质量校准 → 人工终审
  - 后续阶段：**NGL 直接引用 AI 翻译模型（本地 qwen2.5-7b + 云端 OpenAI 兼容），不再依赖 IEGG**，实现平台内端到端闭环
  - 对外口径：避免定死"上下游"关系，可说"当前与IEGG联动，后续平台自闭环"
- **NGL 核心能力**：BDO 专属术语库 + 语料库 + 质检规则，系统性提升翻译初稿质量
- **技术栈**：HTML + 原生 JS 前端 (ui/) + Express 后端 (server/) + PostgreSQL 16.3 (ngl_db)
- **翻译模型**：LM Studio 本地 qwen2.5-7b + OpenAI 兼容云端
- **UI 风格**：Warm Premium（琥珀 #B86932 + 奶油白底）
- **版本**：Frontend v0.9.0，Server v0.3.1

### BDO 13 列 → NGL Key 映射
| raw[] | BDO 字段 | NGL UI 列 |
|---|---|---|
| [0]-[4] | group/obj_id/typeA/typeB/typeC | Key1-Key5 |
| [5] | ko | 原文(韩文) |
| [6] | zh | 译文(中文) |
| [8] | string_key | item.stringKey |

### 本地闭环进度（2026-04-28）
- ✅ 术语库/语料库/规则：前端 → sync-adapter → PG 全通
- ✅ 后端三层防挂（wrap + PG SQLSTATE 映射 + process 兜底）
- ✅ 前端 index.html 补引 sync-adapter.js（修 P0 bug）
- ⏸️ 项目/文件/译文：等 sync-adapter 扩展派发分支
- 已知遗留：sync-adapter update 走 POST 而非 PUT

---

## 基础设施与远程控制

- **公司 PC 台式机**：企微旗舰版（主力 + NGL 源码开发）| iOA 合规（禁第三方 VPN/远控 + 风险软件如 Docker 需合规登记；2026-04-29 已卸 Docker Desktop）
- **公司笔记本电脑**：企微旗舰版（移动办公主力）| iOA 合规域 | 同步策略同台式机 | SSH key 别名 id_ed25519_github | 工作目录 C:\Users\anguscui\WorkBuddy\ngl-workbench
- **NGL PG 部署**：**本机 postgresql-16 服务**（`C:\pgsql16`，5432 trust 无密码），非 Docker —— 备份走 pg_dump/pg_basebackup
- **家里 PC**：微信普通版（轻量 + 部署执行）| Ollama v0.21.2 + qwen2.5:7b | 不装 iOA
- **华为家庭存储**：客户端 MemoSpace，本地同步路径 `G:\ANGUS-A046AC\华为家庭存储\`（SyncRoot），配置文件 `AppData\Local\Huawei\MemoSpace\config\SyncSetting.ini`
- **远程四层**：QClaw(微信远程) → WorkBuddy(AI对话) → GitHub(任务队列) → 腾讯会议(远控)
- **WireGuard**：方案已废弃（公司端 iOA 告警），家里端 10.0.0.2 配置保留但未使用
- **代理**：可乐云机场 SOCKS5:7890 | **硬件**：RTX 4080 SUPER 16GB

### 腾讯云服务器清单

安总在腾讯云控制台只有 **1 台**轻量应用服务器。

| 名称 | IP | 用户 | 认证 | 用途 | 状态 |
|---|---|---|---|---|---|
| Ubuntu-dlaR | **159.75.102.145** | ubuntu | 密码登录 + fail2ban | 赫菲积分管理（Node.js + Express + SQLite）| ✅ 活跃 |

## 跨设备同步 v2.0

- GitHub 唯一真理源，同步范围 `.workbuddy/` 白名单（SOUL/memory/skills）
- SOUL.md 推送需审批，每次对话一个 commit
- 对话启动检查：pull hook → 周一提示清理 → 周五回顾灵魂候选 → 检查 pending-sync

---

## 同步偏好（2026-05-01）

- **所有对话内容全量保留并同步**（含闲聊、探索），不作主观筛选（安总明确要求）
- **多工作区隔离原则**：不同任务开不同工作区，避免同时结束时的 MEMORY.md 冲突
- **合并方式**：各工作区结束后，全部记忆 append 到 ~/wb-soul/MEMORY.md → push GitHub
- **同步架构**：GitHub(wb-soul仓库) 是唯一真理源 → ~/wb-soul/ 是本地副本 → 脚本自动复制到 ~/.workbuddy/ → WB 直接读取

### 已有 Skill 归档范围（2026-05-01）
| Skill | 归档数据 |
|---|---|
| 汇报文档撰写 | BDO汉化数据（字数、BUG、费用、版本号）|
| memory-auto-sync | 同步配置、GitHub仓库结构 |

---

## Obsidian 知识库（2026-05-05 新增）

- **GitHub**：`anguscwf/obsidian-vault`（私有），唯一真理源
- **本地路径**：`C:\Users\ANGUS\obsidian-vault`
- **同步工具**：Obsidian Git 插件 v2.32.1，每10分钟自动 pull+push
- **目录结构**：每日笔记/项目笔记(NGL/BDO汉化/赫菲积分)/技术文档/汇报素材
- **与 wb-soul 关系**：互补——wb-soul 是小管被动记忆，Obsidian 是安总主动知识沉淀

## 个人数字基础设施架构 v3.5（2026-05-06）

### 核心设计：~/wb-soul/ 唯一中转站
- **GitHub 真理源** → `~/wb-soul/`（git clone）↔ `~/.workbuddy/`（WB 读取层）
- 不再依赖工作区是 git clone，统一经 `~/wb-soul/` 读写
- 脚本 `sync-to-workbuddy.ps1`/`.sh` 每小时双向自动同步（pull → cp-in → cp-out → push）
- SSH key 自动探测：`id_ed25519_github`(公司) / `id_ed25519`(家里)
- 新设备/新对话启动自举：git clone wb-soul → pull → cp 到 .workbuddy

### 同步四阶段
1. **pull**：`~/wb-soul/` git pull origin master
2. **cp-in**：`~/wb-soul/` → `~/.workbuddy/`
3. **cp-out**：`~/.workbuddy/memory/` → `~/wb-soul/`
4. **push**：`~/wb-soul/` git add → commit → push

### 四层架构
1. **GitHub 唯一真理源**：wb-soul + ngl-workbench + obsidian-vault
2. **~/wb-soul/ 唯一中转站**：唯一本地 git 仓库，双向脚本自动同步
3. **Sync Skills + 脚本**：memory-auto-sync v3.0 + sync-to-workbuddy.ps1/.sh
4. **设备层**：家里PC + 公司PC + 公司笔记本（SSH key 自动适配）
5. **外部与备份**：腾讯云(赫菲积分) + 华为家庭存储 `G:\ANGUS-A046AC\华为家庭存储\WorkBuddy\`

### 架构图
`安总个人数字基础设施架构v3.5-20260505.svg`

### v3.2 → v3.5 修复的11个漏洞
1. .gitignore 精确化（允许 memory/SOUL/skills 跟踪）
2. ~/wb-soul/ 唯一中转站（不再依赖工作区是 git clone）
3. 对话启动自举（新设备/新对话自动拥有最新 GitHub 数据）
4. 脚本四阶段双向同步（pull→cp-in→cp-out→push 全自动）
5. SSH key 自动探测（公司/家里兼容）
6. SOUL.md 瘦身+修复（60行，同步规则提前到顶部，ngl-workbench→wb-soul）
7. memory-auto-sync skill v2.0→v3.0
8. SOUL.md push 审批取消（脚本直接推送）
9. sync-to-workbuddy 升级为双向
10. 工作区压缩数据不丢失（脚本每小时 push 兜底）
11. 跨设备零手动配置（脚本在 wb-soul 仓库内，pull 即部署）

---

## 赫菲积分小程序（2026-05-06）

- **AppID 已注册**：mp.weixin.qq.com，个人主体
- **名称**：赫菲成长积分管理 | **简称**：赫菲积分
- **Logo**：HF 紫蓝渐变（H=恩赫，F=恩菲），144×144 PNG
- **ICP 备案**：腾讯云订单 30177795660615626，审核中
- **nary 设备**：iPhone 16 Pro Max
- **测试专用账号**（2026-05-07 安总创建）：HTTP 版所有测试必须使用这三个账号，禁止污染家庭真实数据
  - 测试管理（管理员）· 测试家长（家长）· 测试孩子（孩子）
  - 服务器路径：`/home/ubuntu/hefei-points/` · 数据文件：`data/history.json` + `data/points.json`

---

## 公司PC 对齐架构 v3.6.1（2026-05-07 完成）

- **SSH key**：`~/.ssh/id_ed25519`（GitHub 标题 `company-pc-20260507`，首次启用）
- **wb-soul 本地仓**：`~/wb-soul/` 已 clone，作为灵魂中转站
- **计划任务**：`WbSyncBidirectional`，每 1h 静默双向同步（旧任务名 `WbSoulPull` 已废弃）
- **4 个关键 skill 就位**：bootstrap / memory-auto-sync / Angus密码箱 / 汇报文档撰写 ← **前置环境级，跨设备必装，通过 wb-soul 自动同步**
- **套件类 skill（WorkBuddy 市场插件）**：agent-browser / playwright-cli / find-skills / document-skills / finance-data / pptx / pdf / docx / xlsx 等 ← **不走 GitHub 同步，每台设备在 GUI「技能 → 添加技能」按需手动装**。架构 v3.6.1 只管灵魂层同步，套件属工具层正常差异。

### 🎯 跨设备 11 必装 skill 基线（v3.2 架构图原文 · 2026-05-07 锁定）
**每台设备的 WorkBuddy 必须装齐这 11 个，其他 skill 可按需额外装**：

| 分类 | Skill | 安装方式 | 备注 |
|---|---|---|---|
| 入口 | bootstrap | wb-soul 同步 | 前置入口 skill |
| 核心 | memory-auto-sync | wb-soul 同步 | 双向同步灵魂/记忆 |
| 核心 | **self-improving-agent（@pskoett）** | GUI 添加 / `git clone` 手动 | 🚨 2026-05-07 15:51 纠错：**不是 capability-evolver**（曾错判为改名，实为两个独立 skill）。pskoett 版五一装过（56万下载/86K安装/3442星），架构 v3.2 写的就是这个。✅ **2026-05-07 16:03 公司 PC 已手动 clone 装上**：`git clone https://github.com/pskoett/self-improving-agent.git ~/.workbuddy/skills/self-improving-agent`（聚合仓 `pskoett-ai-skills` 163⭐）。**禁止改装 capability-evolver**（@autogame-17，含飞书 token 后门疑云）。 |
| 工具 | obsidian | GUI 添加技能 | 笔记集成 |
| 工具 | agent-browser | GUI 添加技能 | 浏览器自动化 |
| 工具 | Angus密码箱 | wb-soul 同步 | 凭证管理 |
| 文档 | 汇报文档撰写 | wb-soul 同步 | 单页浓缩汇报 |
| 文档 | docx | GUI 添加技能 | Word 文档 |
| 文档 | pdf | GUI 添加技能 | PDF 处理 |
| 文档 | pptx | GUI 添加技能 | PPT 生成 |
| 文档 | xlsx | GUI 添加技能 | Excel 处理 |

**查证方法**（以后发现 skill 清单有疑时）：`grep -oE 'skill-name-pattern' ~/wb-soul/安总个人数字基础设施架构v3.2-20260505.svg` —— v3.2 是 skill 清单的真理源版本，v3.6.1 已缩水不能作为清单基线。

### ❌ 明确禁用 skill 清单（发现装了就卸载）
| Skill | 决策日期 | 原因 |
|---|---|---|
| `download-assistant-v2.1` | 2026-05-07 | 当前架构下完全无用，安总明确要求删除。任何设备（尤其是家里 PC，5-04 装过）发现此 skill 必须在 WorkBuddy GUI「技能」页面卸载 |
| `capability-evolver`（@autogame-17） | 2026-05-07 15:51 | **上午我错判为 self-improving-agent 改名——实为独立 skill**。dev.to 2026-05 安全警报：含硬编码 ByteDance token，读 memory/session_logs/env var 上传到飞书 API；vett.sh 标 ⚠ review；下载量仅 13,981（pskoett 版是 56万，量级差 40 倍，不可能是同一 skill）。任何设备发现装了此 skill 必须卸载，不可用它替代 pskoett/self-improving-agent。 |

### 🟡 按需装 skill 清单（非必装，有场景再装）
| Skill | 用途 | 触发场景 | 备注 |
|---|---|---|---|
| `frontend-design` | AI 前端设计顾问（UI 改版/美化/配色/布局参考） | 给 NGL 或赫菲积分做 UI 大改版时 | 5-04 试装后卸载；4-23 自动化指南标"👀 看情况"最低优先级；当前无 UI 改版场景所以不装；将来要用时 GUI 市场搜一下 5 秒装回来 |

**五一假期原始安装记录（2026-05-04 22:16-00:48 家里 PC · wb-soul/memory/2026-05-04.md L120-150）**：
当日 WB 对话内先对比三家 self-improving agent（xiucheng/Cppp/Dream），最终选装 pskoett 的 `self-improving-agent`（**2026-05-07 15:51 纠错**：上午曾错判为"现已改名 capability-evolver"，实为两个独立 skill，capability-evolver 是 @autogame-17 的另一个东西且有安全问题）；同步搭建 Obsidian 知识库（装 steipete/obsidian skill + Obsidian v1.12.7 + Git 插件 v2.32.1 + 私有仓库 `anguscwf/obsidian-vault`）。当时该设备已装 skill 列表（原文记"11个"实为 **12 个**，数错）：
`Angus密码箱 / agent-browser / docx / download-assistant-v2.1 / frontend-design / memory-auto-sync / obsidian / pdf / pptx / self-improving-agent / xlsx / 汇报文档撰写`
注意：
① 彼时 **bootstrap 尚未创建**（5-05 之后才加）；
② ~~`self-improving-agent` 在市场已改名 `capability-evolver`，同一个东西~~ **2026-05-07 15:51 纠错：这是错的**——pskoett/self-improving-agent 与 @autogame-17/capability-evolver 是两个独立 skill（作者不同/下载量 56万 vs 13,981 量级差 40 倍/功能一个是错题本一个是进化调优）。pskoett 版是否还在市场待确认，但**不能用 capability-evolver 替代**；
③ **`download-assistant-v2.1` 已决策删除**（2026-05-07 安总确认：当前架构下完全无用）——任何设备发现装了这个 skill 都应该在 WorkBuddy GUI 里卸载，不再进任何 skill 清单；
④ `frontend-design` 是 5-04 试装，未进 v3.2 基线，属"**按需装**"（UI 改版时才装，当前不装）—— 详见上方《🟡 按需装 skill 清单》。
→ 这份 5-04 记录 + v3.2 架构图 + bootstrap 追加 − `download-assistant-v2.1` = 11 必装基线的完整证据链。

### ⚠️ 宪法级概念区分：CodeBuddy ≠ WorkBuddy（2026-05-07 锁定）
**两个完全独立的产品，不能混用品牌名**：

| 维度 | WorkBuddy（我们全部在跑的） | CodeBuddy CN（另一个独立产品） |
|---|---|---|
| 安装路径 | `~/AppData/Local/Programs/WorkBuddy/` | `~/AppData/Local/Programs/CodeBuddy CN/` |
| 运行时目录 | `~/.workbuddy/`（全量 skill/memory/plugins） | `~/.codebuddy/`（本机仅 22B，几乎空） |
| Roaming | `~/AppData/Roaming/WorkBuddy/` | `~/AppData/Roaming/CodeBuddy CN/` |
| 版本（2026-05-07） | 4.22.5.0 | 4.4.2 |
| 定位 | Agent 型工作平台（灵魂 + 记忆 + skill 市场） | 编程/IDE 方向产品 |

**我们的所有体系（SOUL/MEMORY/wb-soul/bootstrap/汇报文档撰写/11 必装 skill/技能市场套件）全部属于 WorkBuddy**。以后回答一律说"WorkBuddy 市场插件"、"WorkBuddy GUI"、"WorkBuddy 技能页面"，**绝不能说成"CodeBuddy 市场插件"**——历史对话里凡是我说"CodeBuddy XXX"的都是口误。

- **sync 脚本 v3.6.2**：修复 skills/ 盲区（公司PC 首次部署时发现 P2/P3 未同步 skills），已 push 笔记本下次拉取即可获得
- **memory 双层认知**：`~/.workbuddy/memory/`（全局，上云）vs `<workspace>/.workbuddy/memory/`（项目私有，不上云）—— 以后长期记忆写全局层

_最后整理：2026-05-07 11:40（公司PC 对齐 v3.6.1 + sync 脚本 v3.6.2 修复）_

---

## 宪法级经验：SVG产出&文件真伪鉴别（2026-05-07）

### SVG 裸 & 字符是高频致命 bug
- XML 解析规则：文本中的 `&` 必须转义为 `&amp;`，否则从该位置起整个 SVG 渲染中断
- 高发场景：shell 命令行中的 `&&`、URL 中的 `?a=1&b=2`
- **强制自检命令**：`grep -nE '>[^<]*&[^amp;lt;gt;quot;apos;#][^<]*<' 文件.svg`
- 历史教训：5-06、5-07 两次踩坑，都是 `&&` 未转义

### 文件真伪鉴别铁律
- **文件名相同 + 大小相近 ≠ 同版本**（曾 35,148 vs 35,551 差 400B 但实质差很多）
- 对比必须 `diff -w 文件1 文件2` 看实质，不能只看 `ls -la`
- **GitHub 真理源（~/wb-soul/）永远优先于 workspace 本地文件**，版本错位时一律以 wb-soul 覆盖 workspace
