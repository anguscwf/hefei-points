const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const miniappCheck = require('../../scripts/check-miniapp');

function assertNoErrors(errors) {
  assert.deepEqual(errors, [], errors.join('\n'));
}

test('微信小程序全部 JavaScript 可由 Node 解析', () => {
  assertNoErrors(miniappCheck.checkJavaScriptSyntax());
});

test('微信小程序请求 data/body 不重复携带 legacy token 字段', () => {
  assertNoErrors(miniappCheck.checkRequestTokenFields());
});

test('微信小程序源码不包含 AppSecret、私钥、证书或常见生产密钥', () => {
  assertNoErrors(miniappCheck.checkEmbeddedSecrets());
});

test('微信小程序导航、Toast 与持久存储不携带临时敏感凭据', () => {
  assertNoErrors(miniappCheck.checkSensitiveUiCalls());
});

test('监护端 API 若存在则不暴露孩子端配对申领与设备会话刷新路径', () => {
  assertNoErrors(miniappCheck.checkGuardianApiBoundary());
});

test('静态门能够识别合成 Token body、AppSecret 和敏感导航样本', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-miniapp-security-'));
  const filename = path.join(directory, 'synthetic-violation.js');
  try {
    fs.writeFileSync(filename, [
      "const payload = { token: 'synthetic-bearer-canary' };",
      "client.request('/api/synthetic', { body: JSON.stringify(payload) });",
      "const appSecret = 'synthetic-app-secret-canary';",
      "wx.navigateTo({ url: '/pages/synthetic?reauthAssertion=synthetic-canary' });"
    ].join('\n'));
    assert.ok(miniappCheck.checkRequestTokenFields([filename]).length > 0);
    assert.ok(miniappCheck.checkEmbeddedSecrets([filename]).length > 0);
    assert.ok(miniappCheck.checkSensitiveUiCalls([filename]).length > 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
