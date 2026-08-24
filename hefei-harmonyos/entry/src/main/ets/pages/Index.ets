import { ApiEnvironment } from '../config/ApiEnvironment';
import { ChildApiClient, HarmonyHttpTransport } from '../network/ApiClient';
import { TransactionDto } from '../network/ApiContracts';
import { DeviceIdentity } from '../security/DeviceIdentity';
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

  aboutToAppear(): void {
    this.initialize();
  }

  onPageHide(): void {
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
  }

  private networkReady(): boolean {
    return ApiEnvironment.NETWORK_ENABLED;
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
    await this.coordinator.refreshSelf();
    this.syncView();
  }

  private async loadMore(): Promise<void> {
    this.busy = true;
    await this.coordinator.loadMoreTransactions();
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
        || this.statusCode === 'LOCAL_SECURITY_ERROR') {
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
      Text('儿童端 · 只看自己的积分')
        .fontSize(15)
        .fontColor('#796B61')
      Text(this.statusText())
        .fontSize(14)
        .fontColor('#6A584A')
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .padding({ top: 30, bottom: 18 })
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
      Text(this.phase === EnvelopePhase.WAITING_GUARDIAN
        ? '还差家长确认' : '继续上次的安全操作')
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .fontColor('#3C3028')
      Text(this.phase === EnvelopePhase.WAITING_GUARDIAN
        ? '请让家长核对设备后点击确认。确认完成后，再点下面的按钮。'
        : '应用只会使用原来的请求、签名和幂等键，不会创建第二次操作。')
        .fontSize(15)
        .fontColor('#6F6057')
      Button(this.phase === EnvelopePhase.WAITING_GUARDIAN ? '家长已确认，继续' : '原样恢复')
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
        this.environmentNotice()
        if (this.locked) {
          this.lockedCard()
        } else if (this.phase === EnvelopePhase.UNPAIRED || this.phase === 'BOOT') {
          this.pairingCard()
        } else if (this.phase === EnvelopePhase.CLAIM_INTENT
            || this.phase === EnvelopePhase.WAITING_GUARDIAN
            || this.phase === EnvelopePhase.COMPLETE_RESULT_UNKNOWN
            || this.phase === EnvelopePhase.REFRESH_ISSUE_INTENT
            || this.phase === EnvelopePhase.REFRESH_COMPLETE_INTENT) {
          this.pendingCard()
        } else {
          this.summaryCard()
          this.transactionList()
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
