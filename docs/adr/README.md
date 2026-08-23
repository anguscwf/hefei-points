# 架构决策记录（ADR）

本目录记录会长期影响仓库、发布、安全或产品边界的决定。

命名规则：`NNNN-简短主题.md`。每条 ADR 至少包含状态、日期、背景、决定、影响和后续动作。已经接受的 ADR 不直接改写结论；需要推翻时新增 ADR 并标明替代关系。

当前记录：

- [ADR-0001：以 hefei-points 独立仓库作为唯一真源](0001-canonical-standalone-repository.md)
- [ADR-0002：敏感数据与本地构建材料边界](0002-sensitive-data-and-build-boundaries.md)
- [ADR-0003：阶段 1 采用安全前置的纵向切片](0003-stage1-security-first-vertical-slices.md)
- [ADR-0004：监护授权、儿童状态与可见性边界](0004-guardian-consent-state-and-visibility.md)
- [ADR-0005：生产迁移必须先取得可验证的旧库快照](0005-pre-migration-backup-gate.md)
- [ADR-0006：设备配对、设备身份与会话轮换边界](0006-device-pairing-session-security-boundary.md)
