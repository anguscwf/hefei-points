const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const miniappCheck = require('../../scripts/check-miniapp');
const MINIAPP_PREFIX = `${path.join(path.resolve(__dirname, '../..'), 'hefei-miniapp')}${path.sep}`;

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

test('小程序项目与运行环境配置保持域名校验和生产隔离', () => {
  assertNoErrors(miniappCheck.checkProjectConfiguration());
  assertNoErrors(miniappCheck.checkRuntimeEnvironmentSource());
  assertNoErrors(miniappCheck.checkRuntimeEnvironmentPolicy());
});

test('小程序安全门不会执行偏离已审计模板的运行环境源码', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-miniapp-runtime-fixture-'));
  const filename = path.join(directory, 'runtime-environment.js');
  try {
    fs.writeFileSync(filename, [
      "require('node:fs').readFileSync('project.private.config.json');",
      'module.exports = { resolve: function() {}, isProductionOrigin: function() {} };'
    ].join('\n'));
    const errors = miniappCheck.checkRuntimeEnvironmentSource(filename);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /differs from the audited template/);
    assert.doesNotMatch(errors[0], /project\.private|node:fs/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('小程序安全门只枚举 Git 跟踪普通文件并拒绝私有配置', () => {
  const files = miniappCheck.trackedMiniappFiles();
  assert.ok(files.length > 0);
  assert.ok(files.every(filename => filename.startsWith(MINIAPP_PREFIX)));
  assert.equal(
    files.some(filename => path.basename(filename).toLowerCase() === 'project.private.config.json'),
    false
  );
  assert.deepEqual(
    miniappCheck.parseTrackedMiniappEntries(
      `100644 ${'a'.repeat(40)} 0\thefei-miniapp/project.config.json\0`
    ),
    ['hefei-miniapp/project.config.json']
  );
  assert.throws(
    () => miniappCheck.parseTrackedMiniappEntries(
      `120000 ${'b'.repeat(40)} 0\thefei-miniapp/private-link\0`
    ),
    /stage-zero regular files/
  );
  assert.throws(
    () => miniappCheck.parseTrackedMiniappEntries(
      `100644 ${'c'.repeat(40)} 0\thefei-miniapp/project.private.config.json\0`
    ),
    /private configuration/
  );
  assert.throws(
    () => miniappCheck.parseTrackedMiniappEntries(
      `100644 ${'d'.repeat(40)} 0\thefei-miniapp/synthetic-private.pem\0`
    ),
    /private configuration/
  );
  for (const filename of [
    'hefei-miniapp/project.config.json:private-stream',
    'hefei-miniapp/pages/index/alias.js.',
    'hefei-miniapp/pages/index/alias.js ',
    'hefei-miniapp/pages/index/NUL.txt'
  ]) {
    assert.throws(
      () => miniappCheck.parseTrackedMiniappEntries(
        `100644 ${'e'.repeat(40)} 0\t${filename}\0`
      ),
      /private configuration/
    );
  }
  assert.throws(
    () => miniappCheck.assertCanonicalTrackedRelative(
      'pages/index/PROJEC~1.JSON',
      'project.private.config.json'
    ),
    /non-canonical or private/
  );
});

test('web-view 仅由公开法律文本页使用并处理加载失败', () => {
  assertNoErrors(miniappCheck.checkWebViewBoundary());
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

test('JavaScript 语法失败不回显候选源码或绝对路径', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hefei-miniapp-syntax-fixture-'));
  const filename = path.join(directory, 'synthetic-invalid.js');
  try {
    fs.writeFileSync(filename, "const appSecret = 'synthetic-private-canary' + ;\n");
    const errors = miniappCheck.checkJavaScriptSyntax([filename]);
    assert.deepEqual(errors, ['external-test-fixture: JavaScript syntax check failed']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
