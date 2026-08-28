import { ApiEnvironment } from '../config/ApiEnvironment';
import { ChildApiClient, HarmonyHttpTransport } from '../network/ApiClient';
import { PointRequestDto, RewardRuleDto, TransactionDto } from '../network/ApiContracts';
import {
  PRIVACY_SAFETY_BOUNDARY,
  PrivacySafetySection,
  PrivacySafetySetting,
  privacySafetySections,
  privacySafetySettings
} from '../privacy/PrivacySafetyShell';
import { DeviceIdentity } from '../security/DeviceIdentity';
import { PointRequestVault } from '../security/PointRequestVault';
import { SessionVault } from '../security/SessionVault';
import {
  ChildSessionCoordinator,
  StrictDeviceProofVerifier,
  StrictSecureIdGenerator
} from '../session/ChildSessionCoordinator';
import { EnvelopePhase } from '../session/SessionEnvelope';

@Entry
@Component
struct Index {
  private coordinator: ChildSessionCoordinator = new ChildSessionCoordinator(
    new ChildApiClient(new HarmonyHttpTransport()),
    new DeviceIdentity(),
    new SessionVault(),
    new PointRequestVault(),
    new StrictDeviceProofVerifier(),
    new StrictSecureIdGenerator()
  );

  @State phase: string = 'BOOT';
  @State statusCode: string = 'BOOT';
  @State shortCode: string = '';
  @State busy: boolean = false;
  @State locked: boolean = false;
  @State childName: string = '';
  @State balance: number = 0;
  @State hasSummary: boolean = false;
  @State transactions: Array<TransactionDto> = [];
  @State hasMore: boolean = false;
  @State rewardRules: Array<RewardRuleDto> = [];
  @State hasMoreRewardRules: boolean = false;
  @State selectedRuleId: string = '';
  @State requestedPoints: string = '';
  @State description: string = '';
  @State pointRequests: Array<PointRequestDto> = [];
  @State hasMorePointRequests: boolean = false;
  @State pointRequestPending: boolean = false;
  @State pointRequestDetail: PointRequestDto | null = null;
  @State showPrivacySafety: boolean = false;

  aboutToAppear(): void {
    this.initialize();
  }

  private clearPointDraft(): void {
    this.selectedRuleId = '';
    this.requestedPoints = '';
    this.description = '';
  }

  onPageHide(): void {
    this.shortCode = '';
    this.clearPointDraft();
    this.showPrivacySafety = false;
    this.coordinator.lockForBackground();
    this.syncView();
  }

  onPageShow(): void {
    this.syncView();
  }

  private async initialize(): Promise<void> {
    await this.coordinator.initialize();
    this.syncView();
  }

  private syncView(): void {
    this.phase = this.coordinator.phase;
    this.statusCode = this.coordinator.statusCode;
    this.busy = this.coordinator.busy;
    this.locked = this.coordinator.locked;
    this.childName = this.coordinator.childName;
    this.balance = this.coordinator.balance;
    this.hasSummary = this.coordinator.hasSummary;
    this.transactions = this.coordinator.transactions;
    this.hasMore = this.coordinator.hasMoreTransactions;
    this.rewardRules = this.coordinator.rewardRules;
    this.hasMoreRewardRules = this.coordinator.hasMoreRewardRules;
    this.pointRequests = this.coordinator.pointRequests;
    this.hasMorePointRequests = this.coordinator.hasMorePointRequests;
    this.pointRequestPending = this.coordinator.pointRequestPending;
    this.pointRequestDetail = this.coordinator.pointRequestDetail;
    if (this.locked || this.phase !== EnvelopePhase.ACTIVE || !this.hasSummary) {
      this.clearPointDraft();
    }
    if (this.rewardRules.find((rule: RewardRuleDto) => rule.id === this.selectedRuleId)
        === undefined) {
      this.selectedRuleId = '';
      this.requestedPoints = '';
    }
  }

  private networkReady(): boolean {
    return ApiEnvironment.NETWORK_ENABLED;
  }

  private togglePrivacySafety(): void {
    this.shortCode = '';
    this.clearPointDraft();
    this.showPrivacySafety = !this.showPrivacySafety;
  }

  private async pair(): Promise<void> {
    this.busy = true;
    await this.coordinator.beginPairing(this.shortCode);
    this.shortCode = '';
    this.syncView();
  }

  private async continueAction(): Promise<void> {
    this.busy = true;
    await this.coordinator.continuePendingAction();
    this.syncView();
  }

  private async refreshSelf(): Promise<void> {
    this.busy = true;
    this.pointRequestDetail = null;
    await this.coordinator.refreshSelf();
    this.syncView();
  }

  private async loadMore(): Promise<void> {
    this.busy = true;
    await this.coordinator.loadMoreTransactions();
    this.syncView();
  }

  private selectRule(rule: RewardRuleDto): void {
    this.selectedRuleId = rule.id;
    const preferred: number = Math.max(1, rule.minPoints, rule.defaultPoints);
    this.requestedPoints = `${Math.min(preferred, rule.maxPoints)}`;
  }

  private validRequestedPoints(): boolean {
    const rule: RewardRuleDto | undefined = this.rewardRules.find(
      (value: RewardRuleDto) => value.id === this.selectedRuleId
    );
    const value: number = Number(this.requestedPoints);
    return rule !== undefined && Number.isSafeInteger(value) && value > 0
      && value >= rule.minPoints && value <= rule.maxPoints;
  }

  private async submitPointRequest(): Promise<void> {
    this.busy = true;
    const points: number = Number(this.requestedPoints);
    await this.coordinator.submitPointRequest(
      this.selectedRuleId, points, this.description
    );
    this.clearPointDraft();
    this.syncView();
  }

  private async loadMoreRules(): Promise<void> {
    this.busy = true;
    await this.coordinator.loadMoreRewardRules();
    this.syncView();
  }

  private async loadMoreRequests(): Promise<void> {
    this.busy = true;
    await this.coordinator.loadMorePointRequests();
    this.syncView();
  }

  private async togglePointRequestDetail(item: PointRequestDto): Promise<void> {
    if (this.pointRequestDetail !== null && this.pointRequestDetail.id === item.id) {
      this.coordinator.dismissPointRequestDetail();
      this.syncView();
      return;
    }
    this.busy = true;
    this.pointRequestDetail = null;
    await this.coordinator.loadPointRequestDetail(item.id);
    this.syncView();
  }

  private statusText(): string {
    if (this.statusCode === 'BOOT') return '正在检查本机安全状态';
    if (this.statusCode === 'UNPAIRED') return '这台设备尚未开通';
    if (this.statusCode === 'WAITING_GUARDIAN') return '等待家长在自己的设备上再次确认';
    if (this.statusCode === 'READY') return '设备会话已就绪';
    if (this.statusCode === 'BACKGROUND_LOCKED') return '已隐藏积分内容，回到前台后可重新刷新';
    if (this.statusCode === 'LOCAL_ENVIRONMENT_DISABLED') return '独立测试服务尚未配置，联网功能保持关闭';
    if (this.statusCode === 'CLAIM_RESULT_UNKNOWN') return '上次配对码提交结果待确认，只能原样继续';
    if (this.statusCode === 'RESULT_UNKNOWN') return '上次写操作结果未知，只能原样恢复';
    if (this.statusCode === 'POINT_REQUEST_RESULT_UNKNOWN') {
      return '上次积分申报结果待确认，只能使用原请求恢复';
    }
    if (this.statusCode === 'POINT_REQUEST_SUBMITTED') return '积分申请已提交，等待家长处理';
    if (this.statusCode === 'POINT_REQUEST_RECONCILED') return '已确认原积分申请存在';
    if (this.statusCode === 'POINT_REQUEST_DETAIL_CURRENT') return '这条申请已刷新为服务端当前状态';
    if (this.statusCode === 'POINT_REQUEST_NOT_FOUND') return '这条申请当前无法读取，请整体刷新申请列表';
    if (this.statusCode === 'LOCAL_REQUEST_INVALID') return '只能查看当前列表中唯一的一条申请';
    if (this.statusCode === 'PROTOCOL_ERROR') return '返回内容未通过安全校验，请整体刷新后再试';
    if (this.statusCode === 'SESSION_RECOVERY_REQUIRED') return '设备会话需要安全恢复';
    if (this.statusCode === 'PAIRING_CODE_INVALID') return '配对码无效或已不可用';
    if (this.statusCode === 'PAIRING_LOCKED') return '配对尝试已锁定，请稍后再试';
    if (this.statusCode === 'PAIRING_EXPIRED' || this.statusCode === 'CHALLENGE_EXPIRED') {
      return '本次配对已过期，请家长重新生成配对码';
    }
    if (this.statusCode === 'SESSION_REVOKED' || this.statusCode === 'CONSENT_REQUIRED') {
      return '家长授权或设备会话已失效，需要重新配对';
    }
    if (this.statusCode === 'FEATURE_DISABLED') return '儿童功能门当前关闭，本机凭据已安全保留';
    if (this.statusCode === 'REWARD_RULES_CHANGED') return '家长刚刚更新了规则，请重新刷新选择';
    if (this.statusCode === 'RULE_REFERENCE_INVALID') return '所选规则已更新，请重新刷新选择';
    if (this.statusCode === 'RULE_AMOUNT_OUT_OF_RANGE') return '申报分值已超出当前规则范围';
    if (this.statusCode === 'CHILD_PROCESSING_BLOCKED') return '当前档案已暂停新增积分处理';
    if (this.statusCode === 'ACCESS_TOKEN_EXPIRED') return '访问会话已过期，需要安全刷新';
    if (this.statusCode === 'NETWORK_UNAVAILABLE' || this.statusCode === 'SERVER_UNAVAILABLE') {
      return '网络暂不可用，请稍后再试';
    }
    if (this.statusCode === 'REFRESH_RECOVERY_EXPIRED') {
      return '会话恢复窗口已结束，请由家长撤销设备后重新配对';
    }
    if (this.statusCode === 'VALIDATION_ERROR') return '请输入家长提供的 6 位配对码';
    if (this.statusCode === 'LOCAL_STATE_CORRUPT'
        || this.statusCode === 'DEVICE_KEY_MISSING'
        || this.statusCode === 'LOCAL_STATE_COMMIT_FAILED'
        || this.statusCode === 'LOCAL_SECURITY_ERROR'
        || this.statusCode.startsWith('LOCAL_POINT_INTENT_')
        || this.statusCode === 'POINT_REQUEST_RECONCILIATION_CONFLICT') {
      return '本机安全状态不可验证，已停止读取积分，请联系家长处理';
    }
    return '当前操作未完成，请稍后再试';
  }

  @Builder
  private header() {
    Column({ space: 8 }) {
      Text('糖罐积分')
        .fontSize(30)
        .fontWeight(FontWeight.Bold)
        .fontColor('#2F251E')
      Text('儿童端 · 看自己的积分并提交申请')
        .fontSize(15)
        .fontColor('#796B61')
      Text(this.showPrivacySafety
        ? '纯本地说明，不读取或改变配对状态'
        : this.statusText())
        .fontSize(14)
        .fontColor('#6A584A')
        .textAlign(TextAlign.Center)
      Button(this.showPrivacySafety ? '返回积分页' : '设置与隐私')
        .height(38)
        .backgroundColor('#EADFD7')
        .fontColor('#5B463A')
        .onClick(() => this.togglePrivacySafety())
    }
    .width('100%')
    .padding({ top: 30, bottom: 18 })
  }

  @Builder
  private privacySettingRow(setting: PrivacySafetySetting) {
    Column({ space: 5 }) {
      Row({ space: 12 }) {
        Text(setting.label)
          .fontSize(14)
          .fontColor('#6F6057')
          .layoutWeight(1)
        Text(setting.value)
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .fontColor('#3C3028')
      }
      .width('100%')
      Text(setting.detail)
        .width('100%')
        .fontSize(12)
        .fontColor('#88776B')
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding(14)
    .backgroundColor('#FFF8F3')
    .borderRadius(12)
  }

  @Builder
  private privacySectionCard(section: PrivacySafetySection) {
    Column({ space: 10 }) {
      Text(section.title)
        .width('100%')
        .fontSize(18)
        .fontWeight(FontWeight.Bold)
        .fontColor('#3C3028')
      ForEach(section.items, (item: string, index: number) => {
        Row({ space: 8 }) {
          Text('•')
            .fontSize(14)
            .fontColor('#B8663B')
          Text(item)
            .fontSize(14)
            .fontColor('#62534A')
            .layoutWeight(1)
        }
        .width('100%')
        .alignItems(VerticalAlign.Top)
      }, (_item: string, index: number) => `${section.id}-${index}`)
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding(18)
    .backgroundColor('#FFFFFF')
    .borderRadius(16)
  }

  @Builder
  private privacySafetyShell() {
    Column({ space: 14 }) {
      Column({ space: 8 }) {
        Text('设置与数据安全')
          .width('100%')
          .fontSize(24)
          .fontWeight(FontWeight.Bold)
          .fontColor('#3C3028')
        Text('工程安全说明 · 非正式法律文本')
          .width('100%')
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .fontColor('#8A4B2F')
        Text(PRIVACY_SAFETY_BOUNDARY)
          .width('100%')
          .fontSize(13)
          .fontColor('#735F3C')
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')
      .padding(18)
      .backgroundColor('#FFF2CF')
      .borderRadius(16)

      Column({ space: 10 }) {
        Text('固定安全设置')
          .width('100%')
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .fontColor('#3C3028')
        ForEach(privacySafetySettings(this.networkReady()),
          (setting: PrivacySafetySetting) => {
            this.privacySettingRow(setting)
          }, (setting: PrivacySafetySetting) => setting.id)
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')
      .padding(18)
      .backgroundColor('#FFFFFF')
      .borderRadius(16)

      ForEach(privacySafetySections(), (section: PrivacySafetySection) => {
        this.privacySectionCard(section)
      }, (section: PrivacySafetySection) => section.id)
    }
    .width('100%')
  }

  @Builder
  private environmentNotice() {
    if (!this.networkReady()) {
      Column({ space: 6 }) {
        Text('开发安全门已生效')
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .fontColor('#5B451F')
        Text('独立合成测试服务获批前，本版本不会连接生产儿童业务接口。')
          .fontSize(13)
          .fontColor('#735F3C')
      }
      .width('100%')
      .padding(14)
      .backgroundColor('#FFF2CF')
      .borderRadius(14)
    }
  }

  @Builder
  private lockedCard() {
    Column({ space: 12 }) {
      Text('安全保护已锁定')
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .fontColor('#7B2D24')
      Text('应用无法同时验证设备密钥与安全会话，因此没有读取或展示任何儿童数据。')
        .fontSize(15)
        .fontColor('#5B4A43')
      Text('请让家长在自己的设备上检查授权和设备列表。不要卸载或清除应用数据。')
        .fontSize(14)
        .fontColor('#725D52')
    }
    .width('100%')
    .padding(20)
    .backgroundColor('#FFF0EC')
    .borderRadius(18)
  }

  @Builder
  private pairingCard() {
    Column({ space: 14 }) {
      Text('让家长帮你开通')
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .fontColor('#3C3028')
      Text('家长先在自己的糖罐积分中选择你，再把 6 位配对码告诉你。')
        .fontSize(15)
        .fontColor('#6F6057')
      TextInput({ placeholder: '输入 6 位配对码', text: this.shortCode })
        .type(InputType.Number)
        .maxLength(6)
        .height(52)
        .fontSize(22)
        .textAlign(TextAlign.Center)
        .backgroundColor('#FFFDFC')
        .border({ width: 1, color: '#D7C6B8' })
        .borderRadius(12)
        .onChange((value: string) => {
          this.shortCode = value.replace(/\D/g, '').substring(0, 6);
        })
      Button('提交并等待家长确认')
        .width('100%')
        .height(48)
        .enabled(this.shortCode.length === 6 && this.networkReady() && !this.busy)
        .backgroundColor('#B8663B')
        .fontColor('#FFFFFF')
        .onClick(() => this.pair())
      Text('配对码只用于这一次开通；应用不会读取手机号、华为账号或硬件序列号。')
        .fontSize(12)
        .fontColor('#88776B')
    }
    .width('100%')
    .padding(20)
    .backgroundColor('#FFFFFF')
    .borderRadius(18)
  }

  @Builder
  private pendingCard() {
    Column({ space: 13 }) {
      Text(this.pointRequestPending
        ? '继续上次的积分申报'
        : this.phase === EnvelopePhase.WAITING_GUARDIAN
          ? '还差家长确认' : '继续上次的安全操作')
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .fontColor('#3C3028')
      Text(this.pointRequestPending
        ? '为保护你的说明，这里不会重新显示正文。应用只会先对账，再原样重放安全仓中的请求。'
        : this.phase === EnvelopePhase.WAITING_GUARDIAN
          ? '请让家长核对设备后点击确认。确认完成后，再点下面的按钮。'
          : '应用只会使用原来的请求、签名和幂等键，不会创建第二次操作。')
        .fontSize(15)
        .fontColor('#6F6057')
      Button(this.pointRequestPending
        ? '安全对账并原样恢复'
        : this.phase === EnvelopePhase.WAITING_GUARDIAN ? '家长已确认，继续' : '原样恢复')
        .width('100%')
        .height(48)
        .enabled(this.networkReady() && !this.busy)
        .backgroundColor('#B8663B')
        .fontColor('#FFFFFF')
        .onClick(() => this.continueAction())
    }
    .width('100%')
    .padding(20)
    .backgroundColor('#FFFFFF')
    .borderRadius(18)
  }

  @Builder
  private pointRequestForm() {
    if (this.hasSummary) {
      Column({ space: 12 }) {
        Row() {
          Text('申报完成的任务')
            .fontSize(20)
            .fontWeight(FontWeight.Bold)
            .fontColor('#3C3028')
        }
        .width('100%')
        Text('先选择家长当前设置的鼓励规则，再写一段不超过 120 字的说明。')
          .width('100%')
          .fontSize(13)
          .fontColor('#76665C')
        if (this.rewardRules.length === 0) {
          Text('当前没有可申报的鼓励规则')
            .width('100%')
            .padding(16)
            .fontSize(14)
            .fontColor('#827268')
            .textAlign(TextAlign.Center)
            .backgroundColor('#FFF8F3')
            .borderRadius(12)
        } else {
          ForEach(this.rewardRules, (rule: RewardRuleDto) => {
            Button(`${rule.categoryLabel} · ${rule.label}`)
              .width('100%')
              .height(44)
              .enabled(!this.busy)
              .backgroundColor(this.selectedRuleId === rule.id ? '#B8663B' : '#EADFD7')
              .fontColor(this.selectedRuleId === rule.id ? '#FFFFFF' : '#5B463A')
              .onClick(() => this.selectRule(rule))
          }, (rule: RewardRuleDto) => rule.id)
        }
        if (this.hasMoreRewardRules) {
          Button('加载更多规则')
            .width('100%')
            .height(42)
            .enabled(this.networkReady() && !this.busy)
            .backgroundColor('#F1E8E2')
            .fontColor('#5B463A')
            .onClick(() => this.loadMoreRules())
        }
        if (this.selectedRuleId.length > 0) {
          TextInput({ placeholder: '申报分值', text: this.requestedPoints })
            .type(InputType.Number)
            .enabled(!this.busy)
            .maxLength(4)
            .height(48)
            .fontSize(18)
            .backgroundColor('#FFFDFC')
            .border({ width: 1, color: '#D7C6B8' })
            .borderRadius(12)
            .onChange((value: string) => {
              this.requestedPoints = value.replace(/\D/g, '').substring(0, 4);
            })
          TextInput({ placeholder: '例如：今天主动整理好了书桌', text: this.description })
            .maxLength(120)
            .enabled(!this.busy)
            .height(52)
            .fontSize(15)
            .backgroundColor('#FFFDFC')
            .border({ width: 1, color: '#D7C6B8' })
            .borderRadius(12)
            .onChange((value: string) => {
              this.description = value.replace(/[\u0000-\u001f\u007f]/g, '').substring(0, 120);
            })
          Button('提交给家长确认')
            .width('100%')
            .height(48)
            .enabled(this.networkReady() && !this.busy && !this.pointRequestPending
              && this.validRequestedPoints() && this.description.trim().length > 0)
            .backgroundColor('#B8663B')
            .fontColor('#FFFFFF')
            .onClick(() => this.submitPointRequest())
        }
      }
      .width('100%')
      .padding(20)
      .backgroundColor('#FFFFFF')
      .borderRadius(18)
    }
  }

  private pointRequestStatus(value: PointRequestDto): string {
    if (value.status === 'pending') return '等待家长处理';
    if (value.status === 'needs_info') return '家长请你补充说明';
    if (value.status === 'approved') return '已通过';
    if (value.status === 'rejected') return '未通过';
    return '已取消';
  }

  @Builder
  private pointRequestDetailBody(item: PointRequestDto) {
    Column({ space: 6 }) {
      Text(`当前详情 · 版本 ${item.revision}`)
        .width('100%')
        .fontSize(13)
        .fontWeight(FontWeight.Medium)
        .fontColor('#5B463A')
      Text(`分类：${item.rule.categoryLabel}`)
        .width('100%')
        .fontSize(12)
        .fontColor('#76665C')
      Text(`规则范围：${item.rule.minPoints}—${item.rule.maxPoints} 分${item.rule.unit}`)
        .width('100%')
        .fontSize(12)
        .fontColor('#76665C')
      Text(`完整说明：${item.description}`)
        .width('100%')
        .fontSize(13)
        .fontColor('#5F5148')
      Text(`申报 ${item.requestedPoints} 分${item.approvedPoints === null
        ? '' : ` · 通过 ${item.approvedPoints} 分`}`)
        .width('100%')
        .fontSize(13)
        .fontColor('#5F5148')
      if (item.duplicateSuspected) {
        Text('这条申请可能与近期记录重复，最终由家长确认。')
          .width('100%')
          .fontSize(12)
          .fontColor('#9A5B36')
      }
      if (item.requestInfo !== null) {
        Text(`家长留言：${item.requestInfo.note}`)
          .width('100%')
          .fontSize(13)
          .fontColor('#9A5B36')
        Text(`留言时间：${new Date(item.requestInfo.requestedAt).toLocaleString()}`)
          .width('100%')
          .fontSize(11)
          .fontColor('#928178')
        if (item.requestInfo.resubmittedAt !== null) {
          Text(`补充时间：${new Date(item.requestInfo.resubmittedAt).toLocaleString()}`)
            .width('100%')
            .fontSize(11)
            .fontColor('#928178')
        }
      }
      if (item.decision !== null) {
        if (item.decision.note !== null) {
          Text(`处理说明：${item.decision.note}`)
            .width('100%')
            .fontSize(13)
            .fontColor('#5F5148')
        }
        Text(`处理时间：${new Date(item.decision.reviewedAt).toLocaleString()}`)
          .width('100%')
          .fontSize(11)
          .fontColor('#928178')
      }
      Text(`发生时间：${new Date(item.occurredAt).toLocaleString()}`)
        .width('100%')
        .fontSize(11)
        .fontColor('#928178')
      Text(`提交时间：${new Date(item.submittedAt).toLocaleString()}`)
        .width('100%')
        .fontSize(11)
        .fontColor('#928178')
      Text(`最近更新：${new Date(item.updatedAt).toLocaleString()}`)
        .width('100%')
        .fontSize(11)
        .fontColor('#928178')
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding({ top: 8 })
  }

  @Builder
  private pointRequestList() {
    if (this.hasSummary) {
      Column({ space: 10 }) {
        Row() {
          Text('我的申请')
            .fontSize(20)
            .fontWeight(FontWeight.Bold)
            .fontColor('#3C3028')
        }
        .width('100%')
        if (this.pointRequests.length === 0) {
          Text('还没有积分申请')
            .width('100%')
            .padding(18)
            .fontSize(14)
            .fontColor('#827268')
            .textAlign(TextAlign.Center)
            .backgroundColor('#FFFFFF')
            .borderRadius(14)
        } else {
          ForEach(this.pointRequests, (item: PointRequestDto) => {
            Column({ space: 6 }) {
              Row({ space: 8 }) {
                Text(item.rule.label)
                  .fontSize(16)
                  .fontWeight(FontWeight.Medium)
                  .fontColor('#40352E')
                  .layoutWeight(1)
                Text(this.pointRequestStatus(item))
                  .fontSize(13)
                  .fontColor(item.status === 'approved' ? '#25804B' : '#9A5B36')
              }
              .width('100%')
              Text(`申报 ${item.requestedPoints} 分 · ${item.description}`)
                .width('100%')
                .fontSize(13)
                .fontColor('#6F6057')
                .maxLines(3)
              if (item.requestInfo !== null) {
                Text(`家长留言：${item.requestInfo.note}`)
                  .width('100%')
                  .fontSize(13)
                  .fontColor('#9A5B36')
                  .maxLines(3)
              }
              if (item.status === 'approved' && item.approvedPoints !== null) {
                Text(`通过 ${item.approvedPoints} 分`)
                  .width('100%')
                  .fontSize(14)
                  .fontWeight(FontWeight.Medium)
                  .fontColor('#25804B')
              }
              if (item.decision !== null && item.decision.note !== null) {
                Text(`处理说明：${item.decision.note}`)
                  .width('100%')
                  .fontSize(12)
                  .fontColor('#76665C')
                  .maxLines(3)
              }
              Text(new Date(item.updatedAt).toLocaleString())
                .width('100%')
                .fontSize(11)
                .fontColor('#928178')
              if (this.pointRequestDetail !== null
                  && this.pointRequestDetail.id === item.id) {
                this.pointRequestDetailBody(this.pointRequestDetail)
              }
              Button(this.pointRequestDetail !== null
                && this.pointRequestDetail.id === item.id ? '收起详情' : '查看最新详情')
                .width('100%')
                .height(38)
                .enabled(this.networkReady() && !this.busy && !this.pointRequestPending)
                .backgroundColor('#F1E8E2')
                .fontColor('#5B463A')
                .onClick(() => this.togglePointRequestDetail(item))
            }
            .alignItems(HorizontalAlign.Start)
            .width('100%')
            .padding(16)
            .backgroundColor('#FFFFFF')
            .borderRadius(14)
          }, (item: PointRequestDto) => item.id)
        }
        if (this.hasMorePointRequests) {
          Button('加载更多申请')
            .width('100%')
            .height(44)
            .enabled(this.networkReady() && !this.busy)
            .backgroundColor('#EADFD7')
            .fontColor('#5B463A')
            .onClick(() => this.loadMoreRequests())
        }
      }
      .width('100%')
    }
  }

  @Builder
  private summaryCard() {
    Column({ space: 10 }) {
      Text(this.hasSummary ? `${this.childName}的积分` : '这台设备已经配对')
        .fontSize(17)
        .fontColor('#6C5C52')
      if (this.hasSummary) {
        Text(`${this.balance}`)
          .fontSize(48)
          .fontWeight(FontWeight.Bold)
          .fontColor('#A64F2D')
        Text('当前积分')
          .fontSize(14)
          .fontColor('#8B776C')
      } else {
        Text('点击刷新后，只会读取你自己的余额和流水。')
          .fontSize(15)
          .fontColor('#6F6057')
      }
      Button('安全刷新')
        .width('100%')
        .height(46)
        .enabled(this.networkReady() && !this.busy)
        .backgroundColor('#B8663B')
        .fontColor('#FFFFFF')
        .onClick(() => this.refreshSelf())
    }
    .width('100%')
    .padding(20)
    .backgroundColor('#FFFFFF')
    .borderRadius(18)
  }

  @Builder
  private transactionList() {
    if (this.hasSummary) {
      Column({ space: 10 }) {
        Row() {
          Text('最近流水')
            .fontSize(20)
            .fontWeight(FontWeight.Bold)
            .fontColor('#3C3028')
        }
        .width('100%')
        if (this.transactions.length === 0) {
          Text('还没有积分流水')
            .width('100%')
            .padding(18)
            .fontSize(14)
            .fontColor('#827268')
            .textAlign(TextAlign.Center)
            .backgroundColor('#FFFFFF')
            .borderRadius(14)
        } else {
          ForEach(this.transactions, (item: TransactionDto) => {
            Row({ space: 12 }) {
              Column({ space: 5 }) {
                Text(item.reason)
                  .fontSize(15)
                  .fontColor('#40352E')
                  .maxLines(2)
                Text(new Date(item.occurredAt).toLocaleString())
                  .fontSize(11)
                  .fontColor('#928178')
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)
              Text(item.amount > 0 ? `+${item.amount}` : `${item.amount}`)
                .fontSize(20)
                .fontWeight(FontWeight.Bold)
                .fontColor(item.amount > 0 ? '#25804B' : '#B14335')
            }
            .width('100%')
            .padding(16)
            .backgroundColor('#FFFFFF')
            .borderRadius(14)
          }, (item: TransactionDto) => item.id)
        }
        if (this.hasMore) {
          Button('加载更多')
            .width('100%')
            .height(44)
            .enabled(this.networkReady() && !this.busy)
            .backgroundColor('#EADFD7')
            .fontColor('#5B463A')
            .onClick(() => this.loadMore())
        }
      }
      .width('100%')
    }
  }

  build() {
    Scroll() {
      Column({ space: 16 }) {
        this.header()
        if (this.showPrivacySafety) {
          this.privacySafetyShell()
        } else {
          this.environmentNotice()
          if (this.locked) {
            this.lockedCard()
          } else if (this.phase === EnvelopePhase.UNPAIRED || this.phase === 'BOOT') {
            this.pairingCard()
          } else if (this.pointRequestPending
              || this.phase === EnvelopePhase.CLAIM_INTENT
              || this.phase === EnvelopePhase.WAITING_GUARDIAN
              || this.phase === EnvelopePhase.COMPLETE_RESULT_UNKNOWN
              || this.phase === EnvelopePhase.REFRESH_ISSUE_INTENT
              || this.phase === EnvelopePhase.REFRESH_COMPLETE_INTENT) {
            this.pendingCard()
          } else {
            this.summaryCard()
            this.pointRequestForm()
            this.pointRequestList()
            this.transactionList()
          }
        }
        Text('儿童生产功能门、正式隐私文本和 PIPIA 完成前，本版本不开放生产使用。')
          .width('100%')
          .padding({ top: 12, bottom: 28 })
          .fontSize(11)
          .fontColor('#9A8980')
          .textAlign(TextAlign.Center)
      }
      .width('100%')
      .padding({ left: 18, right: 18 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F7F1ED')
    .scrollBar(BarState.Off)
  }
}
