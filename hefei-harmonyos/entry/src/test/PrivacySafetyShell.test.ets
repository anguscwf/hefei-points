import { describe, expect, it } from '@ohos/hypium';
import {
  PRIVACY_SAFETY_BOUNDARY,
  PRIVACY_SAFETY_SHELL_MARKER,
  PrivacySafetySection,
  PrivacySafetySetting,
  privacySafetySections,
  privacySafetySettings
} from '../main/ets/privacy/PrivacySafetyShell';

function sectionText(sections: Array<PrivacySafetySection>): string {
  let result: string = '';
  sections.forEach((section: PrivacySafetySection) => {
    result += `${section.id}|${section.title}|${section.items.join('|')}|`;
  });
  return result;
}

function settingText(settings: Array<PrivacySafetySetting>): string {
  let result: string = '';
  settings.forEach((setting: PrivacySafetySetting) => {
    result += `${setting.id}|${setting.label}|${setting.value}|${setting.detail}|`;
  });
  return result;
}

export default function privacySafetyShellTests(): void {
  describe('Harmony child local privacy safety shell', () => {
    it('identifies itself as a non-formal local engineering notice', 0, () => {
      expect(PRIVACY_SAFETY_SHELL_MARKER)
        .assertEqual('S10_LOCAL_SAFETY_SHELL_NOT_FORMAL_LEGAL_TEXT');
      expect(PRIVACY_SAFETY_BOUNDARY).assertContain('不是正式隐私政策');
      expect(PRIVACY_SAFETY_BOUNDARY).assertContain('同意页面');
    });

    it('keeps the shell free of URLs, API routes and dynamic identifiers', 0, () => {
      const text: string = PRIVACY_SAFETY_BOUNDARY
        + sectionText(privacySafetySections())
        + settingText(privacySafetySettings(false));
      expect(text.includes('http://')).assertFalse();
      expect(text.includes('https://')).assertFalse();
      expect(text.includes('/api/')).assertFalse();
      expect(text.includes('accessToken')).assertFalse();
      expect(text.includes('refreshToken')).assertFalse();
      expect(text.includes('bindingId')).assertFalse();
      expect(text.includes('sessionId')).assertFalse();
    });

    it('states data minimization, guardian controls and production hard gates', 0, () => {
      const text: string = sectionText(privacySafetySections());
      expect(text).assertContain('不会读取或启用');
      expect(text).assertContain('不读取手机号');
      expect(text).assertContain('当前监护授权');
      expect(text).assertContain('本页不提供假解绑');
      expect(text).assertContain('儿童生产功能保持关闭');
    });

    it('shows only blocked or approved-synthetic network states', 0, () => {
      const blocked: string = settingText(privacySafetySettings(false));
      const synthetic: string = settingText(privacySafetySettings(true));
      expect(blocked).assertContain('联网状态|关闭');
      expect(blocked).assertContain('跟踪开发配置不会连接儿童业务服务');
      expect(synthetic).assertContain('联网状态|仅获批合成测试');
      expect(synthetic).assertContain('只允许临时编译配置连接独立合成环境');
      expect(synthetic.includes('生产')).assertFalse();
    });
  });
}
