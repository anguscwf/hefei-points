const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const harmonyCheck = require('../../scripts/check-harmonyos');

const SAFE_API_ENVIRONMENT = [
  'const CANONICAL_HTTPS_ORIGIN: RegExp = /^https:\\/\\/[a-z0-9.-]+$/;',
  'export function isCanonicalHttpsOrigin(value: string): boolean {',
  '  if (!CANONICAL_HTTPS_ORIGIN.test(value)) return false;',
  "  const hostname: string = value.substring('https://'.length);",
  "  return !hostname.endsWith('.invalid')",
  "    && !hostname.endsWith('.localhost')",
  "    && !hostname.endsWith('.local')",
  "    && !hostname.endsWith('.test');",
  '}',
  'export class ApiEnvironment {',
  "  static readonly PROFILE: string = 'develop-blocked';",
  '  static readonly NETWORK_ENABLED: boolean = false;',
  "  static readonly API_ORIGIN: string = 'https://harmony-child.invalid';",
  '  static assertUsable(): void {',
  '    if (!ApiEnvironment.NETWORK_ENABLED) throw new Error(\'LOCAL_ENVIRONMENT_DISABLED\');',
  '    if (!isCanonicalHttpsOrigin(ApiEnvironment.API_ORIGIN)) {',
  "      throw new Error('LOCAL_ENVIRONMENT_INVALID');",
  '    }',
  '  }',
  '}'
].join('\n');

function write(root, relativePath, source) {
  const filename = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, source);
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tangguan-harmony-security-'));
  write(root, 'entry/src/main/module.json5', `{
    "module": {
      "name": "entry",
      "requestPermissions": [{ "name": "ohos.permission.INTERNET" }],
      "abilities": []
    }
  }`);
  write(
    root,
    'entry/src/main/resources/base/profile/backup_config.json',
    '{"allowToBackupRestore":false}'
  );
  write(root, 'entry/src/main/ets/security/SecureDevice.ets', [
    "import { huks } from '@kit.UniversalKeystoreKit';",
    "import { asset } from '@kit.AssetStoreKit';",
    'export function secureApisAreLinked(): void {',
    '  const storage = huks.HuksTag.HUKS_TAG_AUTH_STORAGE_LEVEL;',
    '  const level = huks.HuksAuthStorageLevel.HUKS_AUTH_STORAGE_LEVEL_ECE;',
    "  huks.hasKeyItem('synthetic-key-alias', { properties: [{ tag: storage, value: level }] });",
    '  const attributes = new Map();',
    '  attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_UNLOCKED);',
    '  attributes.set(asset.Tag.SYNC_TYPE, asset.SyncType.NEVER);',
    '  attributes.set(asset.Tag.REQUIRE_PASSWORD_SET, true);',
    '  attributes.set(asset.Tag.IS_PERSISTENT, false);',
    '  asset.add(attributes);',
    '  asset.query(new Map());',
    '}'
  ].join('\n'));
  write(
    root,
    'entry/src/main/ets/config/RuntimeEnvironment.ets',
    'export const NETWORK_ENABLED: boolean = false;'
  );
  write(root, 'entry/src/main/ets/config/ApiEnvironment.ets', SAFE_API_ENVIRONMENT);
  write(root, 'entry/src/main/ets/network/ChildApi.ets', [
    "const CLAIM = '/api/v2/device-pairings/claim-by-code';",
    "const COMPLETE = '/api/v2/device-pairings/claim/complete';",
    'const CHALLENGE = `/api/v2/devices/${deviceId}/session-challenges`;',
    "const REFRESH = '/api/v2/device-sessions/refresh';",
    "const SUMMARY = '/api/v2/me/summary';",
    "const TRANSACTIONS = '/api/v2/me/transactions?limit=20';"
  ].join('\n'));
  return root;
}

function withFixture(run) {
  const root = createFixture();
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertHas(errors, fragment) {
  assert.ok(
    errors.some(error => error.includes(fragment)),
    `expected error containing ${JSON.stringify(fragment)}:\n${errors.join('\n')}`
  );
}

test('HarmonyOS 主源码通过儿童设备静态安全门', () => {
  const errors = harmonyCheck.scan();
  assert.deepEqual(errors, [], errors.join('\n'));
});

test('合成安全基线通过且扫描范围不依赖私有根构建配置', () => {
  withFixture(root => {
    write(root, 'build-profile.json5', '{ deliberately invalid private fixture');
    assert.deepEqual(harmonyCheck.scan({ harmonyRoot: root }), []);
  });
});

test('静态门拒绝备份恢复、backup extension 和额外权限', () => {
  withFixture(root => {
    write(
      root,
      'entry/src/main/resources/base/profile/backup_config.json',
      '{"allowToBackupRestore":true}'
    );
    write(root, 'entry/src/main/module.json5', `{
      "module": {
        "requestPermissions": [
          { "name": "ohos.permission.INTERNET" },
          { "name": "ohos.permission.READ_MEDIA" }
        ],
        "extensionAbilities": [{
          "name": "EntryBackupAbility",
          "type": "backup",
          "metadata": [{ "name": "ohos.extension.backup" }]
        }]
      }
    }`);
    const errors = harmonyCheck.scan({ harmonyRoot: root });
    assertHas(errors, 'allowToBackupRestore must be false');
    assertHas(errors, 'backup extension ability must be removed');
    assertHas(errors, 'requested permissions must be exactly');
  });
});

test('静态门拒绝生产/health 诊断流与非安全设备、存储和随机 API', () => {
  withFixture(root => {
    write(root, 'entry/src/main/ets/pages/UnsafeDiagnostics.ets', [
      "import { preferences } from '@kit.ArkData';",
      "import { pasteboard } from '@kit.BasicServicesKit';",
      "import deviceInfo from '@ohos.deviceInfo';",
      "import fs from '@ohos.file.fs';",
      "const origin = 'https://hefeijifen.cn';",
      "const route = '/health/live';",
      'PersistentStorage.persistProp("session", "");',
      'const nonce = Math.random();',
      "fs.open('refresh-credential.json');",
      'preferences.getPreferences(null, "session");',
      'pasteboard.getSystemPasteboard();',
      'void deviceInfo;'
    ].join('\n'));
    const errors = harmonyCheck.scan({ harmonyRoot: root });
    for (const fragment of [
      'production origin is forbidden',
      'diagnostic health route is forbidden',
      'forbidden Preferences',
      'forbidden PersistentStorage',
      'forbidden pasteboard',
      'forbidden deviceInfo',
      'forbidden Math.random',
      'forbidden file-backed credential storage',
      'forbidden credential file reference'
    ]) assertHas(errors, fragment);
  });
});

test('静态门拒绝动态日志、启网默认值及缺失 HUKS/AssetStore', () => {
  withFixture(root => {
    write(
      root,
      'entry/src/main/ets/config/RuntimeEnvironment.ets',
      'export const NETWORK_ENABLED: boolean = true;'
    );
    write(
      root,
      'entry/src/main/ets/config/ApiEnvironment.ets',
      SAFE_API_ENVIRONMENT.replace(
        'static readonly NETWORK_ENABLED: boolean = false;',
        'static readonly NETWORK_ENABLED: boolean = true;'
      )
    );
    write(root, 'entry/src/main/ets/security/SecureDevice.ets', [
      '// import { huks } from \'@kit.UniversalKeystoreKit\';',
      '// import { asset } from \'@kit.AssetStoreKit\';',
      '// huks.hasKeyItem(); asset.query();',
      'export const absent = true;'
    ].join('\n'));
    write(root, 'entry/src/main/ets/pages/DynamicLog.ets', [
      "const refreshToken = 'synthetic-canary';",
      "console.info('session', refreshToken);",
      "hilog.warn(1, 'Synthetic', 'value=%{public}s', refreshToken);"
    ].join('\n'));
    const errors = harmonyCheck.scan({ harmonyRoot: root });
    assertHas(errors, 'must not log dynamic data');
    assertHas(errors, 'NETWORK_ENABLED must default to false');
    assertHas(errors, 'NETWORK_ENABLED must not be enabled');
    assertHas(errors, 'HUKS-backed device key usage is required');
    assertHas(errors, 'AssetStore-backed credential storage is required');
  });
});

test('跟踪环境必须保留 invalid 源且启网前执行 canonical HTTPS 校验', () => {
  withFixture(root => {
    write(root, 'entry/src/main/ets/config/ApiEnvironment.ets', [
      'export class ApiEnvironment {',
      "  static readonly PROFILE: string = 'synthetic-approved';",
      "  static readonly API_ORIGIN: string = 'https://harmony-child.invalid' + '.evil.com';",
      '  static readonly NETWORK_ENABLED: boolean = false;',
      '  static assertUsable(): void {',
      "    if (!ApiEnvironment.API_ORIGIN.startsWith('https://')) throw new Error('bad');",
      '  }',
      '}'
    ].join('\n'));
    const errors = harmonyCheck.scan({ harmonyRoot: root });
    assertHas(errors, 'enabled profiles must validate a canonical HTTPS origin');
    assertHas(errors, 'tracked API_ORIGIN must remain a reserved .invalid origin');
  });
});

test('静态门拒绝删除 ApiEnvironment 或把校验调用移出 assertUsable', () => {
  withFixture(root => {
    fs.rmSync(path.join(
      root, 'entry', 'src', 'main', 'ets', 'config', 'ApiEnvironment.ets'
    ));
    assertHas(
      harmonyCheck.scan({ harmonyRoot: root }),
      'ApiEnvironment.ets is required'
    );
  });

  withFixture(root => {
    write(root, 'entry/src/main/ets/config/ApiEnvironment.ets', [
      SAFE_API_ENVIRONMENT,
      'export function unrelated(): boolean {',
      '  return isCanonicalHttpsOrigin(ApiEnvironment.API_ORIGIN);',
      '}'
    ].join('\n').replace(
      "    if (!isCanonicalHttpsOrigin(ApiEnvironment.API_ORIGIN)) {",
      "    if (!ApiEnvironment.API_ORIGIN.startsWith('https://')) {"
    ));
    assertHas(
      harmonyCheck.scan({ harmonyRoot: root }),
      'enabled profiles must validate a canonical HTTPS origin'
    );
  });
});

test('每一个 AssetStore 写入实现都必须独立声明全部安全属性', () => {
  withFixture(root => {
    write(root, 'entry/src/main/ets/security/UnsafePointVault.ets', [
      "import { asset } from '@kit.AssetStoreKit';",
      'export function savePointIntent(): void {',
      '  const safe = new Map();',
      '  safe.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_UNLOCKED);',
      '  safe.set(asset.Tag.SYNC_TYPE, asset.SyncType.NEVER);',
      '  safe.set(asset.Tag.REQUIRE_PASSWORD_SET, true);',
      '  safe.set(asset.Tag.IS_PERSISTENT, false);',
      '  asset.add(safe);',
      '  const unsafe = new Map();',
      "  unsafe.set(asset.Tag.ALIAS, new Uint8Array([1]));",
      "  unsafe.set(asset.Tag.SECRET, new Uint8Array([2]));",
      '  asset.add(unsafe);',
      '}'
    ].join('\n'));
    const errors = harmonyCheck.scan({ harmonyRoot: root });
    for (const fragment of [
      'UnsafePointVault.ets: AssetStore writer must set DEVICE_UNLOCKED',
      'UnsafePointVault.ets: AssetStore writer must set SYNC_TYPE=NEVER',
      'UnsafePointVault.ets: AssetStore writer must set REQUIRE_PASSWORD_SET=true',
      'UnsafePointVault.ets: AssetStore writer must set IS_PERSISTENT=false'
    ]) assertHas(errors, fragment);
  });
});

test('静态门拒绝成人/legacy API 与请求中的客户端身份选择', () => {
  withFixture(root => {
    write(root, 'entry/src/main/ets/network/UnsafeApi.ets', [
      "const adult = '/api/v2/children/synthetic-child/devices';",
      "const legacy = '/api/v1/login';",
      "const splitLegacy = '/api/' + 'login';",
      "requestJson('/api/v2/me/summary', { familyId: 'synthetic-family' });",
      "const payload = { childId: 'synthetic-child' };",
      "requestJson('/api/v2/device-pairings/claim-by-code', payload);"
    ].join('\n'));
    write(root, 'entry/src/main/ets/network/UnsafeAdultPointList.ets', [
      "const adultPointList = '/api/v2/point-requests';",
      "requestJson(adultPointList, { method: 'GET' });"
    ].join('\n'));
    const errors = harmonyCheck.scan({ harmonyRoot: root });
    assert.ok(
      errors.filter(error => error.includes('outside the child-device allowlist')).length >= 3,
      errors.join('\n')
    );
    assertHas(errors, 'business request contains a client-selected identity field');
    assertHas(errors, 'business request variable contains a client-selected identity field');
    assertHas(errors, 'point creation path must stay inside the method-scoped API client');
  });
});

test('静态门拒绝嵌入凭据与凭据文件引用', () => {
  withFixture(root => {
    const tokenCanary = 'tg_' + 'access.' + 'A'.repeat(24);
    write(root, 'entry/src/main/ets/security/EmbeddedCredential.ets', [
      "const appSecret = 'synthetic-canary-not-a-secret';",
      `const bearer = '${tokenCanary}';`,
      "const credentialFile = 'device-session-token.dat';"
    ].join('\n'));
    const errors = harmonyCheck.scan({ harmonyRoot: root });
    assertHas(errors, 'embedded AppSecret assignment');
    assertHas(errors, 'embedded device bearer credential');
    assertHas(errors, 'forbidden credential file reference');
  });
});
