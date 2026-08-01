# 糖罐积分 v2.5.0 数据迁移与回滚手册

## 1. 适用范围

本手册对应里程碑 C（G-06～G-08）：家庭规则隔离、流水关联稳定规则 ID、规则版本历史。数据库仍为 SQLite，不修改 `.env`，不迁移 `index.html` 或 JSON 历史文件。

## 2. 已完成的迁移前备份

- 源数据库：`data/hefei-points.sqlite`
- 备份目录：`backups/2026-08-01T20-43-11/`
- 备份文件：`backups/2026-08-01T20-43-11/hefei-points.sqlite`
- SHA-256：`8CC5B98126EBC6C207E39761D75A768F9F4A5A30708CAE5CF585C518F419215D`
- 备份完整性：`PRAGMA integrity_check = ok`
- 备份基线：家庭 1、用户 4、规则 1、流水 2

备份文件和业务数据库不进入 Git。生产部署时必须在停服后重新执行一次 `npm run backup`，并单独保存该次生产备份路径与 SHA-256。

## 3. 迁移文件与顺序

连接层按文件名升序、在独立 `BEGIN IMMEDIATE` 事务中执行未登记迁移：

1. `server/db/migrations/004_family_rules_history.sql`
   - 将旧单例 `rules(id=1)` 迁入 `rules(family_id='default')`。
   - 新增 `revision`、更新人/更新时间。
   - 新建不可变快照表 `rule_versions`，为旧规则生成 `migration` 基线快照。
   - 其他家庭首次读取规则时创建独立的空 revision 0 快照；默认家庭的定制内容绝不复制或泄露。
2. `server/db/migrations/005_transaction_rule_ids.sql`
   - 为 `transactions` 增加可空的 `rule_id` 与 `category_id`。
   - 两字段必须同时为空或同时存在。
   - 旧流水保持 `reason` 快照，两字段均为 `NULL`。
   - 新增家庭+规则、家庭+分类索引；结构回滚前把关联写入 `transaction_rule_links_v25_archive`，再次升级会自动恢复。

任何一项失败都会回滚该编号的完整迁移，不会留下半完成表结构。

## 4. 正式迁移步骤

1. 停止写入并停掉 PM2 服务。
2. 执行 `npm run backup`，记录新备份路径和 SHA-256。
3. 对备份执行 `PRAGMA integrity_check`，结果必须为 `ok`。
4. 部署 v2.5.0 代码。
5. 启动一次服务；`server/db/connection.js` 会自动执行 004、005。
6. 先检查 `/health/ready`，再执行第 5 节的数据库与 API 核对。
7. 核对通过后再恢复外部流量。

> 备份脚本会打开 SQLite 连接，而连接层会自动执行当前代码目录里的迁移。因此生产环境必须先用旧版本代码完成备份，再部署包含 004/005 的 v2.5.0 代码，不能颠倒顺序。

## 5. 迁移后核对

### 5.1 数据库核对

```sql
PRAGMA integrity_check;
SELECT version FROM schema_migrations ORDER BY version;
SELECT family_id, revision, updated_by, updated_at FROM rules ORDER BY family_id;
SELECT family_id, revision, source, created_at FROM rule_versions ORDER BY family_id, revision;
SELECT COUNT(*) AS transaction_count FROM transactions;
SELECT COUNT(*) AS linked_count FROM transactions WHERE rule_id IS NOT NULL AND category_id IS NOT NULL;
SELECT COUNT(*) AS broken_pair_count
FROM transactions
WHERE (rule_id IS NULL) <> (category_id IS NULL);
SELECT family_id, kid_id, balance FROM point_accounts ORDER BY family_id, kid_id;
SELECT family_id, kid_id, COALESCE(SUM(amount), 0) AS recomputed
FROM transactions
WHERE deleted_at IS NULL
GROUP BY family_id, kid_id
ORDER BY family_id, kid_id;
```

验收条件：完整性为 `ok`；004/005 均登记；默认家庭规则与迁移前 JSON 一致；流水总数不减少；`broken_pair_count=0`；每个孩子余额等于未删除流水求和。

### 5.2 API 核对

- 两个不同家庭 Token 调用 `GET /api/config`，只得到各自规则。
- 家庭 A 在保存请求体伪造家庭 B 的 `familyId`，仍只能更新家庭 A。
- 旧客户端不发送 `familyId/revision/ruleId/categoryId` 时，读取规则和手动记分仍成功。
- 新客户端按规则记分后，历史返回稳定 `ruleId/categoryId`，`reason` 为记分时名称快照。
- 规则改名后，新旧流水按稳定 ID 聚合；旧流水无 ID 时按名称/别名兜底。
- 管理员可列出、查看和恢复本家庭历史；跨家庭版本 ID 返回 404；恢复生成新 revision 且不改流水。

## 6. 回滚预案

### 6.1 首选：恢复迁移前完整备份

适用于迁移失败、完整性异常或需要彻底回到迁移前状态。

1. 立即停服并保留故障数据库副本，禁止继续写入。
2. 将第 2 步产生的生产备份恢复为 `data/hefei-points.sqlite`；同时恢复同名 `-wal`/`-shm` 状态时必须确保服务已完全停止，通常只恢复已完成 checkpoint 的主库备份。
3. 部署 v2.4.0 代码。
4. 启动后核对完整性、家庭/用户/余额/流水数量。

这是唯一能把数据库逐字节恢复到迁移前状态的方案。

### 6.2 结构回滚：保留 v2.5 规则归档

适用于迁移已成功、但应用需要临时退回 v2.4.0，同时希望保留迁移后的多家庭规则和历史：

1. 停服并再次备份当前 v2.5 数据库。
2. 在一个受控维护窗口内，依次执行：
   - `server/db/rollbacks/005_transaction_rule_ids.sql`
   - `server/db/rollbacks/004_family_rules_history.sql`
3. 005 删除 live 关联列与索引，但会先把规则/分类关联归档到 `transaction_rule_links_v25_archive`；全部原流水字段和 `reason` 快照保持不变。
4. 004 恢复 v2.4 单例 `rules(id=1)`；多家庭规则与历史分别复制到 `rules_v25_archive`、`rule_versions_v25_archive`，不会删除。
5. 部署并启动 v2.4.0，再核对积分与流水。

004 回滚会移除对应迁移登记，因此之后重新部署 v2.5.0 时可自动重跑 004/005；两张 archive 表仍保留用于审计。若发生过多次升级/回滚，仍应优先恢复步骤 1 保存的 v2.5 完整备份，避免长期累积归档表带来人工判断错误。

若临时运行 v2.4.0 期间默认家庭又保存过规则，再升级时 004 会比较 revision：保留 revision 较高的 v2.4 单例，并为它补一条 `migration` 基线快照；其他家庭仍从 v2.5 archive 完整恢复。

## 7. 演练与测试记录

- 使用迁移前备份完成“升级 → 结构回滚 → 再升级”往返演练，三个阶段 `PRAGMA integrity_check` 均为 `ok`。
- 004：旧规则只归入默认家庭；多家庭规则隔离；回滚归档后再次升级可恢复全部家庭规则与版本历史。
- 005：旧流水保留；关联列成对约束生效；回滚时关联归档、再次升级自动恢复。
- 家庭隔离、伪造家庭 ID、规则引用越权、revision 冲突、跨家庭历史、恢复不改流水均有自动化测试。
- 本地正式迁移结果（2026-08-02）：家庭 1、用户 4、流水 2；恩菲余额/重算均为 21，恩赫余额/重算均为 -125；关联断裂数 0。
- 自动化测试 29/29 通过；`server/` 与 `hefei-miniapp/` 共 44 个 JS 文件通过 `node --check`。
- 微信开发者工具真实 preview 编译成功，包体 1,159,192 bytes，未发现项目编译错误。
