export const PRIVACY_SAFETY_SHELL_MARKER: string =
  'S10_LOCAL_SAFETY_SHELL_NOT_FORMAL_LEGAL_TEXT';

export const PRIVACY_SAFETY_BOUNDARY: string =
  '这是开发阶段的数据与安全说明，不是正式隐私政策、儿童个人信息保护规则、儿童用户协议或同意页面。';

export interface PrivacySafetySetting {
  id: string;
  label: string;
  value: string;
  detail: string;
}

export interface PrivacySafetySection {
  id: string;
  title: string;
  items: Array<string>;
}

export function privacySafetySettings(networkEnabled: boolean): Array<PrivacySafetySetting> {
  return [
    {
      id: 'version',
      label: '当前版本',
      value: '0.2.0 (20000)',
      detail: '仍是未发布的阶段 1 本地验证版本。'
    },
    {
      id: 'device-alias',
      label: '设备名称',
      value: 'HarmonyOS 手机',
      detail: '这是通用设备别名；本页不读取硬件名称或序列号。'
    },
    {
      id: 'network',
      label: '联网状态',
      value: networkEnabled ? '仅获批合成测试' : '关闭',
      detail: networkEnabled
        ? '只允许临时编译配置连接独立合成环境。'
        : '跟踪开发配置不会连接儿童业务服务。'
    },
    {
      id: 'background',
      label: '离开页面',
      value: '自动隐藏',
      detail: '积分内容、规则、申请列表和输入草稿会从当前业务视图清除。'
    },
    {
      id: 'notifications',
      label: '通知与照片',
      value: '关闭',
      detail: '首发安全切片不使用通知、相册、相机或照片证据。'
    },
    {
      id: 'backup',
      label: '应用备份恢复',
      value: '关闭',
      detail: '设备安全钥匙、会话和未决文字不会进入应用备份。'
    }
  ];
}

export function privacySafetySections(): Array<PrivacySafetySection> {
  return [
    {
      id: 'used-data',
      title: '会用到哪些信息',
      items: [
        '家长设置的昵称、积分、积分流水、可申报规则，以及你主动提交的文字说明。',
        '本机会生成随机设备标识和不可导出的安全钥匙，用来确认配对设备。'
      ]
    },
    {
      id: 'not-used',
      title: '当前不会读取或启用',
      items: [
        '不读取手机号、华为账号、硬件序列号、通讯录、位置、相册、相机或麦克风。',
        '照片证据、通知、广告、支付、第三方统计和用机兑换保持关闭。'
      ]
    },
    {
      id: 'visibility',
      title: '谁可以查看和处理',
      items: [
        '这台配对设备只读取当前孩子自己的积分、规则、流水和申请。',
        '只有具备当前监护授权的家长，才能在家长端查看并处理对应孩子的数据。'
      ]
    },
    {
      id: 'guardian-actions',
      title: '需要停止或更正时',
      items: [
        '设备解绑、撤回授权、查阅、更正、删除或终止服务，都请让家长在家长端发起。',
        '本页不提供假解绑或本地清除按钮；清除应用数据不等于服务端已经解绑。',
        '家长撤回授权或撤销设备后，服务端会停止处理并撤销相关设备会话。'
      ]
    },
    {
      id: 'formal-notice',
      title: '正式文本与帮助',
      items: [
        '正式隐私政策、儿童个人信息保护规则、儿童用户协议和客服投诉入口仍待定稿发布。',
        '在正式文本、PIPIA、存量整改、备案和发布审查完成前，儿童生产功能保持关闭。'
      ]
    }
  ];
}
