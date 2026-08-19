import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { BusinessError, deviceInfo, pasteboard } from '@kit.BasicServicesKit';
import { http } from '@kit.NetworkKit';

const HEALTH_URL: string = 'https://hefeijifen.cn/health/live';
const STORE_NAME: string = 'tangguan_phase_zero';
const TEST_VALUE_KEY: string = 'storage_test_value';
const DIAGNOSTIC_ID_KEY: string = 'diagnostic_id';
const LAUNCH_COUNT_KEY: string = 'launch_count';
const APP_VERSION: string = '0.1.0';
const BUILD_NUMBER: string = '10000';
const BUNDLE_NAME: string = 'cn.hefeijifen.tangguan';
const BUILD_DATE: string = '2026-08-09';

@Entry
@Component
struct Index {
  private store?: preferences.Preferences;

  @State diagnosticId: string = '正在初始化';
  @State launchCount: number = 0;
  @State storageValue: string = '尚未读取';
  @State storageStatus: string = '等待测试';
  @State networkStatus: string = '尚未测试';
  @State networkSummary: string = '点击按钮验证 HTTPS、DNS 和证书链';
  @State networkOk: boolean = false;
  @State isTestingNetwork: boolean = false;
  @State copyStatus: string = '复制诊断结果';
  @State lifecycleEvents: Array<string> = [];
  @State minorModeChecked: boolean = false;
  @State alwaysAllowedChecked: boolean = false;
  @State limitedLaunchChecked: boolean = false;
  @State restartLaunchChecked: boolean = false;
  @StorageProp('phase0LifecycleState') abilityLifecycleState: string = '正在启动';
  @StorageProp('phase0LifecycleTransition') abilityLifecycleTransition: string = '未启动 → 正在启动';
  @StorageProp('phase0LifecycleChangedAt') abilityLifecycleChangedAt: number = 0;
  @StorageProp('phase0LifecycleCount') abilityLifecycleCount: number = 0;

  aboutToAppear(): void {
    this.addLifecycleEvent('页面创建');
    this.initializeStorage();
  }

  onPageShow(): void {
    this.addLifecycleEvent('进入前台');
  }

  onPageHide(): void {
    this.addLifecycleEvent('进入后台');
  }

  private nowText(): string {
    return new Date().toLocaleString();
  }

  private addLifecycleEvent(eventName: string): void {
    const event: string = `${this.nowText()} · ${eventName}`;
    this.lifecycleEvents = [event].concat(this.lifecycleEvents).slice(0, 8);
  }

  private async getStore(): Promise<preferences.Preferences> {
    if (this.store) {
      return this.store;
    }
    const context: common.Context | undefined = this.getUIContext().getHostContext();
    if (!context) {
      throw new Error('无法获取应用上下文');
    }
    try {
      this.store = await preferences.getPreferences(context, { name: STORE_NAME });
      return this.store;
    } catch (error) {
      const businessError: BusinessError = error as BusinessError;
      throw new Error(`打开诊断存储失败：${businessError.code}`);
    }
  }

  private async initializeStorage(): Promise<void> {
    try {
      const store: preferences.Preferences = await this.getStore();
      const savedCount: preferences.ValueType = await store.get(LAUNCH_COUNT_KEY, 0);
      this.launchCount = (savedCount as number) + 1;
      await store.put(LAUNCH_COUNT_KEY, this.launchCount);

      const savedId: preferences.ValueType = await store.get(DIAGNOSTIC_ID_KEY, '');
      let id: string = savedId as string;
      if (id.length === 0) {
        id = `P0-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        await store.put(DIAGNOSTIC_ID_KEY, id);
      }
      this.diagnosticId = id;

      const savedValue: preferences.ValueType = await store.get(TEST_VALUE_KEY, '');
      this.storageValue = (savedValue as string).length > 0 ? savedValue as string : '尚未写入';
      this.storageStatus = '本地存储已就绪';
      await store.flush();
    } catch (error) {
      const businessError: BusinessError = error as BusinessError;
      this.storageStatus = `初始化失败 · ${businessError.code}`;
    }
  }

  private async writeStorageValue(): Promise<void> {
    try {
      const value: string = `NOVA14-P0-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      const store: preferences.Preferences = await this.getStore();
      await store.put(TEST_VALUE_KEY, value);
      await store.flush();
      this.storageValue = value;
      this.storageStatus = `写入成功 · ${this.nowText()}`;
      this.addLifecycleEvent('写入本地测试值');
    } catch (error) {
      const businessError: BusinessError = error as BusinessError;
      this.storageStatus = `写入失败 · ${businessError.code}`;
    }
  }

  private async readStorageValue(): Promise<void> {
    try {
      const store: preferences.Preferences = await this.getStore();
      const savedValue: preferences.ValueType = await store.get(TEST_VALUE_KEY, '');
      this.storageValue = (savedValue as string).length > 0 ? savedValue as string : '当前为空';
      this.storageStatus = `读取完成 · ${this.nowText()}`;
      this.addLifecycleEvent('读取本地测试值');
    } catch (error) {
      const businessError: BusinessError = error as BusinessError;
      this.storageStatus = `读取失败 · ${businessError.code}`;
    }
  }

  private async deleteStorageValue(): Promise<void> {
    try {
      const store: preferences.Preferences = await this.getStore();
      await store.delete(TEST_VALUE_KEY);
      await store.flush();
      this.storageValue = '已删除';
      this.storageStatus = `删除完成 · ${this.nowText()}`;
      this.addLifecycleEvent('删除本地测试值');
    } catch (error) {
      const businessError: BusinessError = error as BusinessError;
      this.storageStatus = `删除失败 · ${businessError.code}`;
    }
  }

  private async clearDiagnosticData(): Promise<void> {
    try {
      const store: preferences.Preferences = await this.getStore();
      await store.clear();
      await store.flush();
      this.launchCount = 0;
      this.diagnosticId = '已清除，重启后重新生成';
      this.storageValue = '已清除';
      this.storageStatus = '全部诊断数据已清除';
      this.lifecycleEvents = [];
      this.addLifecycleEvent('清除全部诊断数据');
    } catch (error) {
      const businessError: BusinessError = error as BusinessError;
      this.storageStatus = `清除失败 · ${businessError.code}`;
    }
  }

  private async testHttps(): Promise<void> {
    if (this.isTestingNetwork) {
      return;
    }

    this.isTestingNetwork = true;
    this.networkOk = false;
    this.networkStatus = '正在连接…';
    this.networkSummary = HEALTH_URL;
    const startedAt: number = Date.now();
    const request: http.HttpRequest = http.createHttp();

    try {
      const response: http.HttpResponse = await request.request(HEALTH_URL, {
        method: http.RequestMethod.GET,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 10000,
        readTimeout: 10000
      });
      const elapsed: number = Date.now() - startedAt;
      const statusCode: number = response.responseCode as number;
      this.networkOk = statusCode === 200;
      this.networkStatus = this.networkOk
        ? `HTTPS 正常 · HTTP ${statusCode} · ${elapsed} ms`
        : `服务响应异常 · HTTP ${statusCode} · ${elapsed} ms`;
      this.networkSummary = typeof response.result === 'string'
        ? response.result.substring(0, 120)
        : '服务器已返回非文本响应';
      this.addLifecycleEvent(`HTTPS 测试完成（${statusCode}）`);
    } catch (error) {
      const elapsed: number = Date.now() - startedAt;
      const businessError: BusinessError = error as BusinessError;
      this.networkStatus = `请求失败 · ${elapsed} ms`;
      this.networkSummary = `错误 ${businessError.code} · ${businessError.message}`;
      this.addLifecycleEvent('HTTPS 测试失败');
    } finally {
      request.destroy();
      this.isTestingNetwork = false;
    }
  }

  private composeDiagnosticResult(): string {
    return [
      '糖罐积分 · 阶段 0 诊断',
      `版本 ${APP_VERSION} (${BUILD_NUMBER})`,
      `Bundle ${BUNDLE_NAME}`,
      `设备 ${deviceInfo.productModel}`,
      `系统 ${deviceInfo.displayVersion}`,
      `系统详情 ${deviceInfo.osFullName}`,
      `API ${deviceInfo.sdkApiVersion}`,
      `诊断 ID ${this.diagnosticId}`,
      `启动次数 ${this.launchCount}`,
      `网络 ${this.networkStatus}`,
      `存储 ${this.storageStatus}`,
      `测试值 ${this.storageValue}`,
      `生成时间 ${this.nowText()}`
    ].join('\n');
  }

  private async copyDiagnosticResult(): Promise<void> {
    try {
      const data: pasteboard.PasteData = pasteboard.createData(
        pasteboard.MIMETYPE_TEXT_PLAIN,
        this.composeDiagnosticResult()
      );
      await pasteboard.getSystemPasteboard().setData(data);
      this.copyStatus = '已复制到剪贴板';
    } catch (error) {
      const businessError: BusinessError = error as BusinessError;
      this.copyStatus = `复制失败 · ${businessError.code}`;
    }
  }

  @Builder
  private cardTitle(title: string, subtitle: string) {
    Column({ space: 3 }) {
      Text(title)
        .fontSize(20)
        .fontWeight(FontWeight.Bold)
        .fontColor('#263B36')
        .width('100%')
      Text(subtitle)
        .fontSize(13)
        .fontColor('#72817C')
        .width('100%')
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
  }

  @Builder
  private infoRow(label: string, value: string) {
    Row() {
      Text(label)
        .fontSize(14)
        .fontColor('#7B8883')
        .width(88)
      Text(value)
        .fontSize(14)
        .fontColor('#263B36')
        .fontWeight(FontWeight.Medium)
        .layoutWeight(1)
        .textAlign(TextAlign.End)
        .maxLines(2)
    }
    .width('100%')
    .padding({ top: 7, bottom: 7 })
  }

  @Builder
  private manualCheckRow(label: string, checked: boolean, onChange: (value: boolean) => void) {
    Row({ space: 10 }) {
      Toggle({ type: ToggleType.Checkbox, isOn: checked })
        .selectedColor('#2D9B7A')
        .onChange(onChange)
      Text(label)
        .fontSize(14)
        .fontColor('#344A44')
        .layoutWeight(1)
    }
    .width('100%')
    .padding({ top: 6, bottom: 6 })
  }

  build() {
    Scroll() {
      Column({ space: 14 }) {
        Column({ space: 8 }) {
          Row({ space: 12 }) {
            Text('🍬')
              .fontSize(30)
              .width(58)
              .height(58)
              .textAlign(TextAlign.Center)
              .backgroundColor('#FFF4D9')
              .borderRadius(18)
            Column({ space: 3 }) {
              Text('糖罐积分 · 阶段 0')
                .fontSize(24)
                .fontWeight(FontWeight.Bold)
                .fontColor('#FFFFFF')
              Text('HarmonyOS 真机兼容诊断')
                .fontSize(14)
                .fontColor('#D7F4EA')
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)
          }
          .width('100%')

          Text('无 ACL · 无业务数据 · 不申请敏感权限')
            .fontSize(13)
            .fontColor('#E9FFF7')
            .padding({ left: 12, right: 12, top: 6, bottom: 6 })
            .backgroundColor('#33FFFFFF')
            .borderRadius(14)
            .alignSelf(ItemAlign.Start)
        }
        .width('100%')
        .padding(20)
        .backgroundColor('#2D9B7A')
        .borderRadius(24)

        Column({ space: 2 }) {
          this.cardTitle('应用与设备', '仅显示系统公开信息，不读取硬件唯一标识')
          Divider().color('#E8F0ED').margin({ top: 10, bottom: 4 })
          this.infoRow('应用版本', `${APP_VERSION} (${BUILD_NUMBER})`)
          this.infoRow('Bundle', BUNDLE_NAME)
          this.infoRow('构建日期', BUILD_DATE)
          this.infoRow('设备型号', deviceInfo.productModel)
          this.infoRow('HarmonyOS', deviceInfo.displayVersion)
          this.infoRow('系统详情', deviceInfo.osFullName)
          this.infoRow('API 级别', `${deviceInfo.sdkApiVersion}`)
          Row() {
            Text('诊断 ID')
              .fontSize(14)
              .fontColor('#7B8883')
              .width(88)
            Text(this.diagnosticId)
              .fontSize(14)
              .fontColor('#263B36')
              .fontWeight(FontWeight.Medium)
              .layoutWeight(1)
              .textAlign(TextAlign.End)
              .maxLines(2)
          }
          .width('100%')
          .padding({ top: 7, bottom: 7 })
          Row() {
            Text('累计启动')
              .fontSize(14)
              .fontColor('#7B8883')
              .width(88)
            Text(`${this.launchCount} 次`)
              .fontSize(14)
              .fontColor('#263B36')
              .fontWeight(FontWeight.Medium)
              .layoutWeight(1)
              .textAlign(TextAlign.End)
              .maxLines(2)
          }
          .width('100%')
          .padding({ top: 7, bottom: 7 })
        }
        .width('100%')
        .padding(18)
        .backgroundColor('#FFFFFF')
        .borderRadius(20)

        Column({ space: 12 }) {
          this.cardTitle('HTTPS 连接', '固定验证正式域名，不允许降级到 HTTP')
          Text(HEALTH_URL)
            .fontSize(13)
            .fontColor('#2D9B7A')
            .width('100%')
          Column({ space: 5 }) {
            Text(this.networkStatus)
              .fontSize(17)
              .fontWeight(FontWeight.Bold)
              .fontColor(this.networkOk ? '#13795B' : '#5F6F69')
              .width('100%')
            Text(this.networkSummary)
              .fontSize(13)
              .fontColor('#7B8883')
              .maxLines(3)
              .width('100%')
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')
          .padding(14)
          .backgroundColor(this.networkOk ? '#E9FAF3' : '#F4F8F6')
          .borderRadius(14)
          Button(this.isTestingNetwork ? '测试中…' : '测试 HTTPS')
            .width('100%')
            .height(46)
            .fontSize(16)
            .fontWeight(FontWeight.Bold)
            .fontColor('#FFFFFF')
            .backgroundColor('#2D9B7A')
            .enabled(!this.isTestingNetwork)
            .onClick(() => {
              this.testHttps();
            })
        }
        .width('100%')
        .padding(18)
        .backgroundColor('#FFFFFF')
        .borderRadius(20)

        Column({ space: 12 }) {
          this.cardTitle('本地存储', '测试值不含账号、积分或任何儿童资料')
          Column({ space: 5 }) {
            Text(this.storageValue)
              .fontSize(15)
              .fontWeight(FontWeight.Medium)
              .fontColor('#3A4E48')
              .maxLines(2)
              .width('100%')
            Text(this.storageStatus)
              .fontSize(13)
              .fontColor('#7B8883')
              .width('100%')
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')
          .padding(14)
          .backgroundColor('#FFF8E8')
          .borderRadius(14)
          Row({ space: 8 }) {
            Button('写入')
              .layoutWeight(1)
              .backgroundColor('#EBAF32')
              .fontColor('#FFFFFF')
              .onClick(() => {
                this.writeStorageValue();
              })
            Button('读取')
              .layoutWeight(1)
              .backgroundColor('#E9F6F1')
              .fontColor('#237C63')
              .onClick(() => {
                this.readStorageValue();
              })
            Button('删除')
              .layoutWeight(1)
              .backgroundColor('#FFF0ED')
              .fontColor('#C15C4B')
              .onClick(() => {
                this.deleteStorageValue();
              })
          }
          .width('100%')
        }
        .width('100%')
        .padding(18)
        .backgroundColor('#FFFFFF')
        .borderRadius(20)

        Column({ space: 10 }) {
          this.cardTitle('生命周期', '记录最近 8 次页面前后台事件')
          Column({ space: 4 }) {
            Text(`Ability：${this.abilityLifecycleState}`)
              .fontSize(15)
              .fontWeight(FontWeight.Bold)
              .fontColor('#2D6F5B')
              .width('100%')
            Text(`最近转换：${this.abilityLifecycleTransition}`)
              .fontSize(13)
              .fontColor('#657771')
              .width('100%')
            Text(`本次进程事件：${this.abilityLifecycleCount} 次`)
              .fontSize(13)
              .fontColor('#657771')
              .width('100%')
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')
          .padding(14)
          .backgroundColor('#E9F7F2')
          .borderRadius(14)
          Text(this.lifecycleEvents.length > 0 ? this.lifecycleEvents.join('\n') : '暂无事件')
            .fontSize(13)
            .fontColor('#566A64')
            .lineHeight(22)
            .width('100%')
            .padding(14)
            .backgroundColor('#F3F8F6')
            .borderRadius(14)
        }
        .width('100%')
        .padding(18)
        .backgroundColor('#FFFFFF')
        .borderRadius(20)

        Column({ space: 6 }) {
          this.cardTitle('未成年人模式人工验收', '普通 App 无法可靠读取该系统状态，请按真机结果勾选')
          this.manualCheckRow('已开启未成年人／孩子使用模式', this.minorModeChecked, (value: boolean) => {
            this.minorModeChecked = value;
          })
          this.manualCheckRow('已将糖罐积分设为“始终允许”', this.alwaysAllowedChecked, (value: boolean) => {
            this.alwaysAllowedChecked = value;
          })
          this.manualCheckRow('达到系统限额后仍可正常启动', this.limitedLaunchChecked, (value: boolean) => {
            this.limitedLaunchChecked = value;
          })
          this.manualCheckRow('锁屏、杀进程或重启后仍可启动', this.restartLaunchChecked, (value: boolean) => {
            this.restartLaunchChecked = value;
          })
        }
        .width('100%')
        .padding(18)
        .backgroundColor('#FFFFFF')
        .borderRadius(20)

        Column({ space: 10 }) {
          Button(this.copyStatus)
            .width('100%')
            .height(46)
            .fontSize(16)
            .fontWeight(FontWeight.Bold)
            .fontColor('#FFFFFF')
            .backgroundColor('#2D9B7A')
            .onClick(() => {
              this.copyDiagnosticResult();
            })
          Button('清除全部诊断数据')
            .width('100%')
            .height(44)
            .fontSize(14)
            .fontColor('#B25346')
            .backgroundColor('#FFF2EF')
            .onClick(() => {
              this.clearDiagnosticData();
            })
          Text('阶段 0 仅验证运行环境，不连接家庭账号，不修改积分。')
            .fontSize(12)
            .fontColor('#87938F')
            .textAlign(TextAlign.Center)
            .width('100%')
        }
        .width('100%')
        .margin({ bottom: 26 })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 18 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F1F8F5')
  }
}
