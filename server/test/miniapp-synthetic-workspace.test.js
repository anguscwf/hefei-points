const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const scriptFile = path.join(projectRoot, 'scripts', 'prepare-miniapp-synthetic-workspace.js');
const canonicalMiniapp = path.join(projectRoot, 'hefei-miniapp');
const canonicalEnvironment = path.join(canonicalMiniapp, 'utils', 'runtime-environment.js');
const canonicalProjectConfig = path.join(canonicalMiniapp, 'project.config.json');
const workspace = require('../../scripts/prepare-miniapp-synthetic-workspace');
const SYNTHETIC_ORIGIN = 'https://synthetic-api.example.com';
const SYNTHETIC_APP_ID = 'wx0123456789abcdef';
const EXCLUDED_TRACKED_FILES = ['hefei-miniapp/README.md'];
const ALLOWED_EXTENSIONS = new Set(['.js', '.json', '.png', '.svg', '.wxml', '.wxss']);
const SAFE_GIT_PREFIX = [
  '--no-pager',
  '--no-optional-locks',
  '--no-replace-objects',
  '-c', 'core.fsmonitor=false',
  '-c', `safe.directory=${projectRoot.split(path.sep).join('/')}`
];

function isWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeGitEnvironment() {
  const environment = {
    ...process.env,
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0'
  };
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    if (normalized === 'GIT_CONFIG_COUNT'
        || normalized === 'GIT_CONFIG_PARAMETERS'
        || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(normalized)
        || normalized.startsWith('GIT_TRACE')) delete environment[key];
  }
  return environment;
}

function git(arguments_, options = {}) {
  return execFileSync('git', [...SAFE_GIT_PREFIX, ...arguments_], {
    cwd: projectRoot,
    windowsHide: true,
    env: safeGitEnvironment(),
    ...options
  });
}

function selectedTrackedEntries() {
  const output = git(['ls-files', '--stage', '-z', '--', 'hefei-miniapp'], {
    encoding: 'utf8'
  });
  const entries = output.split('\0').filter(Boolean).map(record => {
    const match = /^(100644|100755) ([0-9a-f]{40,64}) 0\t(.+)$/.exec(record);
    assert.ok(match, record);
    return { mode: match[1], oid: match[2], filename: match[3] };
  });
  const selected = [];
  for (const entry of entries) {
    const filename = entry.filename;
    if (EXCLUDED_TRACKED_FILES.includes(filename)) continue;
    assert.equal(ALLOWED_EXTENSIONS.has(path.extname(filename).toLowerCase()), true, filename);
    selected.push(entry);
  }
  return selected.sort((left, right) => (
    left.filename < right.filename ? -1 : (left.filename > right.filename ? 1 : 0)
  ));
}

function selectedTrackedFiles() {
  return selectedTrackedEntries().map(entry => entry.filename);
}

function indexInputs(files) {
  const entries = selectedTrackedEntries();
  assert.deepEqual(entries.map(entry => entry.filename), files);
  const output = git(['cat-file', '--batch'], {
    encoding: null,
    input: `${entries.map(entry => entry.oid).join('\n')}\n`,
    maxBuffer: 64 * 1024 * 1024
  });
  const inputs = [];
  let offset = 0;
  for (const entry of entries) {
    const filename = entry.filename;
    const headerEnd = output.indexOf(0x0a, offset);
    assert.ok(headerEnd >= 0, filename);
    const match = /^([0-9a-f]{40,64}) blob ([0-9]+)$/.exec(
      output.subarray(offset, headerEnd).toString('utf8')
    );
    assert.ok(match, filename);
    assert.equal(match[1], entry.oid, filename);
    const length = Number(match[2]);
    const start = headerEnd + 1;
    const end = start + length;
    assert.equal(output[end], 0x0a, filename);
    inputs.push({ filename, content: output.subarray(start, end) });
    offset = end + 1;
  }
  assert.equal(offset, output.length);
  return inputs;
}

function framedDigest(inputs) {
  const digest = crypto.createHash('sha256');
  for (const input of inputs) {
    digest.update(Buffer.from(`${input.filename}\0${input.content.length}\0`, 'utf8'));
    digest.update(input.content);
  }
  return digest.digest('hex');
}

function filenameDigest(files) {
  return crypto.createHash('sha256').update(files.join('\0'), 'utf8').digest('hex');
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function withTemporaryParent(work) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tangguan-miniapp-workspace-'));
  const finish = () => {
    const metadata = fs.lstatSync(parent);
    const resolved = (fs.realpathSync.native || fs.realpathSync)(parent);
    const temporary = (fs.realpathSync.native || fs.realpathSync)(path.resolve(os.tmpdir()));
    assert.equal(metadata.isDirectory() && !metadata.isSymbolicLink(), true);
    assert.equal(isWithin(temporary, resolved), true);
    assert.match(path.basename(resolved), /^tangguan-miniapp-workspace-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  };
  try {
    const result = work(parent);
    if (result && typeof result.then === 'function') return result.finally(finish);
    finish();
    return result;
  } catch (error) {
    finish();
    throw error;
  }
}

function prepare(output) {
  return workspace.prepareWorkspace({
    origin: SYNTHETIC_ORIGIN,
    appId: SYNTHETIC_APP_ID,
    output,
    acknowledgedOrigin: true,
    acknowledgedAppId: true
  });
}

function filesIn(directory, root = directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesIn(filename, root));
    else files.push(path.relative(root, filename).split(path.sep).join('/'));
  }
  return files.sort();
}

function clearGeneratedModules(project) {
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const prefix = normalize(`${path.resolve(project)}${path.sep}`);
  for (const filename of Object.keys(require.cache)) {
    if (normalize(filename).startsWith(prefix)) delete require.cache[filename];
  }
}

function wxRuntime(envVersion, calls) {
  const storage = Object.create(null);
  return {
    getAccountInfoSync() {
      return { miniProgram: { envVersion } };
    },
    getExtConfigSync() {
      return { apiOrigin: 'https://hefeijifen.cn' };
    },
    getLaunchOptionsSync() {
      return { query: { apiOrigin: 'https://hefeijifen.cn' } };
    },
    getEnterOptionsSync() {
      return { query: { apiOrigin: 'https://hefeijifen.cn' } };
    },
    getStorageSync(key) {
      return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : '';
    },
    setStorageSync(key, value) {
      storage[key] = value;
    },
    removeStorageSync(key) {
      delete storage[key];
    },
    request(options) {
      calls.push(options);
      options.success({
        statusCode: 200,
        header: { 'X-Request-Id': 'synthetic-miniapp-workspace' },
        data: { success: true, texts: {} }
      });
    }
  };
}

async function withGeneratedApp(project, envVersion, work) {
  const previousApp = global.App;
  const previousWx = global.wx;
  const calls = [];
  let definition;
  global.App = value => { definition = value; };
  global.wx = wxRuntime(envVersion, calls);
  clearGeneratedModules(project);
  try {
    require(path.join(project, 'app.js'));
    assert.ok(definition, 'generated app.js did not register an App');
    const app = Object.assign({}, definition, {
      globalData: structuredClone(definition.globalData)
    });
    return await work(app, calls);
  } finally {
    clearGeneratedModules(project);
    global.App = previousApp;
    global.wx = previousWx;
  }
}

test('小程序 synthetic 参数要求 canonical 非生产源和独立 AppID', () => {
  assert.deepEqual(workspace.parseArguments([
    '--origin', SYNTHETIC_ORIGIN,
    '--app-id', SYNTHETIC_APP_ID,
    '--output', 'C:\\synthetic-output',
    '--acknowledge-approved-synthetic-origin',
    '--acknowledge-independent-synthetic-app-id'
  ]), {
    origin: SYNTHETIC_ORIGIN,
    output: 'C:\\synthetic-output',
    appId: SYNTHETIC_APP_ID,
    acknowledgedOrigin: true,
    acknowledgedAppId: true,
    help: false
  });
  assert.equal(workspace.canonicalHttpsOrigin(SYNTHETIC_ORIGIN), true);
  for (const origin of [
    'http://synthetic-api.example.com',
    'https://SYNTHETIC-api.example.com',
    'https://user@synthetic-api.example.com',
    'https://synthetic-api.example.com:443',
    'https://synthetic-api.example.com/',
    'https://127.0.0.1',
    'https://synthetic-api.invalid',
    'https://synthetic-api.test'
  ]) assert.equal(workspace.canonicalHttpsOrigin(origin), false, origin);
  assert.throws(
    () => workspace.validateApprovedOrigin('https://hefeijifen.cn'),
    /production origin is forbidden/
  );
  assert.throws(
    () => workspace.validateApprovedOrigin('https://preview.hefeijifen.cn'),
    /production origin is forbidden/
  );
  assert.equal(workspace.validateSyntheticAppId(SYNTHETIC_APP_ID), SYNTHETIC_APP_ID);
  for (const appId of ['touristappid', 'wx0123456789ABCDEf', 'wx0123456789abcde', 'wx0123456789abcdef0']) {
    assert.throws(() => workspace.validateSyntheticAppId(appId), /canonical WeChat AppID/);
  }
  const sourceConfig = JSON.parse(fs.readFileSync(canonicalProjectConfig, 'utf8'));
  assert.throws(
    () => workspace.validateSyntheticAppId(sourceConfig.appid, sourceConfig.appid),
    /independent/
  );
  assert.throws(() => workspace.parseArguments(['--unknown']), /unknown argument/);
  assert.throws(
    () => workspace.parseArguments(['--origin', SYNTHETIC_ORIGIN, '--origin', SYNTHETIC_ORIGIN]),
    /duplicate argument/
  );
  assert.deepEqual(workspace.selectTrackedMiniappFiles([
    'hefei-miniapp/README.md',
    'hefei-miniapp/app.js',
    'hefei-miniapp/images/tangguan-avatar.png'
  ]), [
    'hefei-miniapp/app.js',
    'hefei-miniapp/images/tangguan-avatar.png'
  ]);
  assert.throws(
    () => workspace.selectTrackedMiniappFiles(['hefei-miniapp/utils/unaudited.wxs']),
    /unaudited file type/
  );

  const unsafeConfig = JSON.parse(fs.readFileSync(canonicalProjectConfig, 'utf8'));
  unsafeConfig.miniprogramRoot = '../outside';
  assert.throws(() => workspace.generatedInputs([
    {
      filename: 'hefei-miniapp/utils/runtime-environment.js',
      content: fs.readFileSync(canonicalEnvironment)
    },
    {
      filename: 'hefei-miniapp/project.config.json',
      content: Buffer.from(JSON.stringify(unsafeConfig), 'utf8')
    }
  ], SYNTHETIC_ORIGIN, SYNTHETIC_APP_ID), /external root/);
});

test('小程序 synthetic 输出只允许系统临时目录中的全新真实路径', () => {
  assert.throws(
    () => workspace.resolveOutput(path.join(projectRoot, 'miniapp-synthetic-output')),
    /outside the canonical repository/
  );
  if (process.platform === 'win32') {
    assert.throws(
      () => workspace.resolveOutput('\\\\synthetic-host\\share\\workspace'),
      /local temporary directory/
    );
  }
  withTemporaryParent(parent => {
    const existing = path.join(parent, 'existing');
    fs.mkdirSync(existing);
    assert.throws(() => workspace.resolveOutput(existing), /must not already exist/);
    assert.throws(() => workspace.resolveOutput(path.join(parent, 'NUL')), /canonical local directory/);
    assert.throws(
      () => workspace.prepareWorkspace({
        origin: SYNTHETIC_ORIGIN,
        appId: SYNTHETIC_APP_ID,
        output: path.join(parent, 'missing-origin-ack'),
        acknowledgedOrigin: false,
        acknowledgedAppId: true
      }),
      /origin acknowledgement/
    );
    assert.throws(
      () => workspace.prepareWorkspace({
        origin: SYNTHETIC_ORIGIN,
        appId: SYNTHETIC_APP_ID,
        output: path.join(parent, 'missing-app-ack'),
        acknowledgedOrigin: true,
        acknowledgedAppId: false
      }),
      /app id acknowledgement/
    );
    const repositoryAlias = path.join(parent, 'repository-alias');
    fs.symlinkSync(
      projectRoot,
      repositoryAlias,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    assert.throws(
      () => workspace.resolveOutput(path.join(repositoryAlias, 'physical-repository-output')),
      /real local temporary directory|outside the canonical repository/
    );
  });
});

test('只从与 HEAD 一致的 Git 索引生成 synthetic-only 小程序且 canonical 源不变', async () => {
  await withTemporaryParent(async parent => {
    const output = path.join(parent, 'miniapp-synthetic');
    const originalEnvironment = fs.readFileSync(canonicalEnvironment);
    const originalProjectConfig = fs.readFileSync(canonicalProjectConfig);
    prepare(output);
    assert.equal(fs.readFileSync(canonicalEnvironment).equals(originalEnvironment), true);
    assert.equal(fs.readFileSync(canonicalProjectConfig).equals(originalProjectConfig), true);

    const project = path.join(output, 'hefei-miniapp');
    const generatedEnvironmentFile = path.join(project, 'utils', 'runtime-environment.js');
    const generatedEnvironmentSource = fs.readFileSync(generatedEnvironmentFile, 'utf8');
    assert.match(generatedEnvironmentSource, new RegExp(SYNTHETIC_ORIGIN.replaceAll('.', '\\.')));
    assert.doesNotMatch(generatedEnvironmentSource, /https:\/\/hefeijifen\.cn/i);
    delete require.cache[require.resolve(generatedEnvironmentFile)];
    const environment = require(generatedEnvironmentFile);
    for (const envVersion of ['develop', 'trial']) {
      const profile = environment.resolve(envVersion);
      assert.equal(profile.apiBase, SYNTHETIC_ORIGIN);
      assert.equal(profile.environmentReady, true);
      assert.equal(profile.guardianPreviewEnabled, true);
      assert.equal(profile.production, false);
      assert.equal(profile.legalOrigin, SYNTHETIC_ORIGIN);
    }
    for (const envVersion of ['release', 'unknown', 'production']) {
      const profile = environment.resolve(envVersion);
      assert.equal(profile.apiBase, 'https://blocked.invalid');
      assert.equal(profile.environmentReady, false);
      assert.equal(profile.guardianPreviewEnabled, false);
      assert.equal(profile.production, false);
    }
    assert.equal(environment.isProductionOrigin('https://hefeijifen.cn'), true);
    assert.equal(environment.isProductionOrigin('https://preview.hefeijifen.cn'), true);

    const config = JSON.parse(fs.readFileSync(path.join(project, 'project.config.json'), 'utf8'));
    const sourceConfig = JSON.parse(originalProjectConfig.toString('utf8'));
    assert.equal(config.appid, SYNTHETIC_APP_ID);
    assert.notEqual(config.appid, sourceConfig.appid);
    assert.equal(config.compileType, 'miniprogram');
    assert.equal(config.setting.urlCheck, true);
    assert.equal(config.setting.uploadWithSourceMap, false);
    assert.equal(config.projectname, 'hefei-points-synthetic');
    assert.equal(fs.existsSync(path.join(project, 'project.private.config.json')), false);
    assert.equal(fs.existsSync(path.join(project, 'README.md')), false);

    const manifest = JSON.parse(fs.readFileSync(
      path.join(output, '.synthetic-workspace.json'), 'utf8'
    ));
    const selectedFiles = selectedTrackedFiles();
    const sourceInputs = indexInputs(selectedFiles);
    const generatedInputs = selectedFiles.map(filename => ({
      filename,
      content: fs.readFileSync(path.join(output, ...filename.split('/')))
    }));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.projectType, 'wechat-miniapp');
    assert.equal(manifest.profile, 'miniapp-synthetic-approved');
    assert.match(manifest.sourceCommit, /^[0-9a-f]{40,64}$/);
    assert.equal(manifest.sourceCommit, git(['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim());
    assert.equal(manifest.sourceTreeSha256, framedDigest(sourceInputs));
    assert.equal(manifest.auditedSourceTreeRequired, true);
    assert.equal(manifest.auditedSourceTreeSha256, manifest.sourceTreeSha256);
    assert.equal(manifest.generatedTreeSha256, framedDigest(generatedInputs));
    assert.equal(manifest.clientSourceIndexMatchesHead, true);
    assert.equal(manifest.clientSourceWorktreeInspected, false);
    assert.equal(manifest.clientSourceWorktreeUsed, false);
    assert.equal(manifest.sourceSelectedTrackedFileCount, selectedFiles.length);
    assert.equal(manifest.sourceSelectedTrackedFilesSha256, filenameDigest(selectedFiles));
    assert.deepEqual(manifest.sourceExplicitlyExcludedTrackedFiles, EXCLUDED_TRACKED_FILES);
    assert.equal(manifest.origin, SYNTHETIC_ORIGIN);
    assert.equal(manifest.uploadWithSourceMap, false);
    assert.equal(
      manifest.appIdSha256,
      crypto.createHash('sha256').update(SYNTHETIC_APP_ID).digest('hex')
    );
    for (const field of [
      'independentAppIdOperatorAcknowledged',
      'independentAppIdStringDiffersFromCanonical',
      'trackedFilesOnly',
      'temporaryWorkspace',
      'developTrialSyntheticOnly',
      'releaseFailClosed',
      'unknownFailClosed',
      'urlCheckRequired',
      'requiresExternalInfrastructureApproval'
    ]) assert.equal(manifest[field], true, field);
    for (const field of [
      'independentAppIdProvisioningVerified',
      'developerAuthorizationVerified',
      'sourcePrivateConfigCopied',
      'devToolsPrivateConfigVerified',
      'requestDomainVerified',
      'businessDomainVerified',
      'infrastructureConnectivityVerified',
      'devToolsInvoked',
      'previewOrUploadPerformed'
    ]) assert.equal(manifest[field], false, field);
    assert.deepEqual(manifest.patchedFiles.map(item => item.path), [
      'hefei-miniapp/utils/runtime-environment.js',
      'hefei-miniapp/project.config.json'
    ]);
    for (const patched of manifest.patchedFiles) {
      const content = fs.readFileSync(path.join(output, ...patched.path.split('/')));
      assert.equal(sha256(content), patched.sha256);
    }
    assert.deepEqual(manifest.implementationFiles.map(item => item.path), [
      'scripts/prepare-miniapp-synthetic-workspace.js',
      'scripts/check-miniapp.js',
      'scripts/prepare-harmonyos-synthetic-workspace.js'
    ]);
    for (const implementation of manifest.implementationFiles) {
      assert.equal(
        implementation.sha256,
        sha256(fs.readFileSync(path.join(projectRoot, ...implementation.path.split('/'))))
      );
    }

    const generatedFiles = filesIn(output);
    assert.deepEqual(generatedFiles, ['.synthetic-workspace.json', ...selectedFiles].sort());
    assert.equal(generatedFiles.some(filename => filename.startsWith('.git/')), false);
    assert.equal(generatedFiles.some(filename => /project\.private\.config\.json$/i.test(filename)), false);
    assert.equal(generatedFiles.some(filename => /\.(?:p12|pfx|pem|key|cer|crt)$/i.test(filename)), false);
    for (const filename of generatedFiles.filter(value => /\.(?:js|json|wxml|wxss)$/i.test(value))) {
      if (filename === 'hefei-miniapp/utils/runtime-environment.js') continue;
      assert.doesNotMatch(
        fs.readFileSync(path.join(output, ...filename.split('/')), 'utf8'),
        /hefei(?:\s*['"`]\s*\+\s*['"`]\s*)?jifen/i
      );
    }

    for (const envVersion of ['develop', 'trial']) {
      await withGeneratedApp(project, envVersion, async (app, calls) => {
        const legacy = await app.fetchAPI('/api/config');
        const v2 = await app.requestV2({
          path: '/api/v2/legal-texts/current',
          auth: 'public'
        });
        assert.equal(legacy.success, true);
        assert.equal(v2.ok, true);
        assert.deepEqual(calls.map(call => call.url), [
          `${SYNTHETIC_ORIGIN}/api/config`,
          `${SYNTHETIC_ORIGIN}/api/v2/legal-texts/current`
        ]);
        for (const value of [
          '@hefeijifen.cn/api/config',
          '.hefeijifen.cn/api/config',
          '//hefeijifen.cn/api/config',
          '/api\\@hefeijifen.cn/config',
          'https://hefeijifen.cn/api/config'
        ]) {
          const rejected = await app.fetchAPI(value);
          assert.equal(rejected.code, 'CLIENT_REQUEST_INVALID', `${envVersion}: ${value}`);
        }
        assert.equal(calls.length, 2);
      });
    }
    for (const envVersion of ['release', 'unknown']) {
      await withGeneratedApp(project, envVersion, async (app, calls) => {
        const legacy = await app.fetchAPI('/api/config');
        const v2 = await app.requestV2({
          path: '/api/v2/legal-texts/current',
          auth: 'public'
        });
        assert.equal(legacy.code, 'API_ENVIRONMENT_INVALID');
        assert.equal(v2.code, 'API_ENVIRONMENT_INVALID');
        assert.equal(calls.length, 0);
      });
    }
  });
});

test('生成中途失败不留下最终目录或半成品 staging', () => {
  withTemporaryParent(parent => {
    const output = path.join(parent, 'miniapp-synthetic-failure');
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = function(filename, ...args) {
      if (path.basename(String(filename)) === '.synthetic-workspace.json') {
        throw new Error('synthetic injected manifest failure');
      }
      return originalWrite.call(fs, filename, ...args);
    };
    try {
      assert.throws(() => prepare(output), /synthetic injected manifest failure/);
    } finally {
      fs.writeFileSync = originalWrite;
    }
    assert.equal(fs.existsSync(output), false);
    assert.equal(
      fs.readdirSync(parent).some(name => name.startsWith('.tangguan-miniapp-stage-')),
      false
    );
  });
});

test('原子发布 rename 是成功路径最后一次文件系统操作', () => {
  withTemporaryParent(parent => {
    const output = path.join(parent, 'miniapp-synthetic-atomic-publish');
    const originals = new Map();
    let published = false;
    const originalRename = fs.renameSync;
    fs.renameSync = function(from, to) {
      const result = originalRename.call(fs, from, to);
      if (path.resolve(String(to)) === path.resolve(output)) published = true;
      return result;
    };
    for (const name of ['existsSync', 'lstatSync', 'statSync', 'readFileSync', 'readdirSync']) {
      const original = fs[name];
      originals.set(name, original);
      fs[name] = function(filename, ...args) {
        if (published) throw new Error(`post-publish filesystem operation: ${name}`);
        return original.call(fs, filename, ...args);
      };
    }
    try {
      assert.equal(prepare(output), output);
      assert.equal(published, true);
    } finally {
      fs.renameSync = originalRename;
      for (const [name, original] of originals) fs[name] = original;
    }
    assert.equal(fs.existsSync(path.join(output, '.synthetic-workspace.json')), true);
    assert.equal(
      fs.readdirSync(parent).some(name => name.startsWith('.tangguan-miniapp-stage-')),
      false
    );
  });
});

test('CLI 不联网、不调用 DevTools/上传且输出不回显 origin、AppID 或路径', () => {
  withTemporaryParent(parent => {
    const output = path.join(parent, 'cli-miniapp-synthetic');
    const guard = path.join(parent, 'deny-network-and-tools.cjs');
    const expectedBatchInput = `${selectedTrackedEntries().map(entry => entry.oid).join('\n')}\n`;
    fs.writeFileSync(guard, [
      "const deny = () => { throw new Error('EXTERNAL_IO_DISABLED_BY_TEST'); };",
      "const net = require('node:net'); net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny;",
      "const dns = require('node:dns'); dns.lookup = deny; dns.resolve = deny; dns.resolve4 = deny; dns.resolve6 = deny;",
      'dns.Resolver.prototype.resolve = deny; dns.Resolver.prototype.resolve4 = deny; dns.Resolver.prototype.resolve6 = deny;',
      "const http = require('node:http'); const https = require('node:https');",
      'http.request = deny; http.get = deny; http.ClientRequest = deny; https.request = deny; https.get = deny;',
      "const tls = require('node:tls'); const http2 = require('node:http2');",
      'tls.connect = deny; http2.connect = deny;',
      "const dgram = require('node:dgram'); dgram.createSocket = deny;",
      'if (dns.promises) { dns.promises.lookup = deny; dns.promises.resolve = deny; dns.promises.resolve4 = deny; dns.promises.resolve6 = deny; }',
      'globalThis.fetch = deny;',
      "const path = require('node:path'); const fs = require('node:fs');",
      `const canonicalRoot = ${JSON.stringify(projectRoot)};`,
      `const miniappRoot = ${JSON.stringify(path.join(projectRoot, 'hefei-miniapp'))};`,
      "const privateName = /(?:^|[\\\\/])(?:\\.env(?:$|\\.)|project\\.private\\.config\\.json$)/i;",
      'const forbiddenRead = filename => {',
      '  const resolved = path.resolve(String(filename));',
      '  return resolved === miniappRoot || resolved.startsWith(miniappRoot + path.sep)',
      '    || ((resolved === canonicalRoot || resolved.startsWith(canonicalRoot + path.sep))',
      '      && privateName.test(String(filename)));',
      '};',
      "for (const name of ['readFileSync', 'openSync', 'createReadStream']) {",
      '  const original = fs[name];',
      '  fs[name] = function(filename, ...args) {',
      '    if (forbiddenRead(filename)) return deny();',
      '    return original.call(fs, filename, ...args);',
      '  };',
      '}',
      "for (const name of ['readFile', 'open']) {",
      '  const original = fs[name];',
      '  fs[name] = function(filename, ...args) {',
      '    if (forbiddenRead(filename)) return deny();',
      '    return original.call(fs, filename, ...args);',
      '  };',
      '}',
      'if (fs.promises) {',
      "  for (const name of ['readFile', 'open']) {",
      '    const original = fs.promises[name];',
      '    fs.promises[name] = function(filename, ...args) {',
      '      if (forbiddenRead(filename)) return deny();',
      '      return original.call(fs.promises, filename, ...args);',
      '    };',
      '  }',
      '}',
      "const child = require('node:child_process'); const originalExecFileSync = child.execFileSync;",
      `const expectedGitPrefix = ${JSON.stringify(SAFE_GIT_PREFIX)};`,
      `const expectedBatchInput = ${JSON.stringify(expectedBatchInput)};`,
      `const allowedGitCommands = new Set(${JSON.stringify([
        ['rev-parse', '--show-toplevel'],
        ['rev-parse', '--verify', 'HEAD'],
        ['ls-files', '--stage', '-z', '--', 'hefei-miniapp'],
        ['ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', 'hefei-miniapp'],
        ['cat-file', '--batch']
      ].map(value => JSON.stringify(value)))});`,
      'child.execFileSync = function(file, args, options) {',
      '  const prefixMatches = file === \'git\' && Array.isArray(args)',
      '    && expectedGitPrefix.every((value, index) => args[index] === value);',
      '  const command = prefixMatches ? args.slice(expectedGitPrefix.length) : [];',
      '  const environment = options && options.env || {};',
      '  const forbiddenEnvironment = Object.keys(environment).some(key => /^(?:GIT_TRACE|GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_|VALUE_))/i.test(key));',
      "  const secretEnvironmentPresent = Object.prototype.hasOwnProperty.call(environment, 'WX_APPSECRET')",
      "    || Object.prototype.hasOwnProperty.call(environment, 'SYNTHETIC_GIT_ENV_CANARY');",
      "  const batchInputValid = command[0] !== 'cat-file' || options.input === expectedBatchInput;",
      "  const allowed = prefixMatches && allowedGitCommands.has(JSON.stringify(command))",
      "    && environment.GIT_NO_LAZY_FETCH === '1'",
      "    && environment.GIT_NO_REPLACE_OBJECTS === '1'",
      "    && environment.GIT_OPTIONAL_LOCKS === '0'",
      "    && environment.GIT_CONFIG_NOSYSTEM === '1'",
      "    && environment.GIT_ATTR_NOSYSTEM === '1'",
      "    && environment.GIT_PROTOCOL_FROM_USER === '0'",
      '    && batchInputValid && !forbiddenEnvironment && !secretEnvironmentPresent;',
      '  if (!allowed) return deny();',
      '  return originalExecFileSync.call(child, file, args, options);',
      '};',
      'child.exec = deny; child.execSync = deny; child.execFile = deny;',
      'child.spawn = deny; child.spawnSync = deny; child.fork = deny;'
    ].join('\n'));
    const nodeOptions = `--require=${guard.split(path.sep).join('/')}`;
    const childEnvironment = {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      SYNTHETIC_GIT_ENV_CANARY: 'must-not-enter-git-child',
      WX_APPSECRET: 'synthetic-parent-secret-must-not-enter-git-child'
    };
    const result = spawnSync(process.execPath, [
      scriptFile,
      '--origin', SYNTHETIC_ORIGIN,
      '--app-id', SYNTHETIC_APP_ID,
      '--output', output,
      '--acknowledge-approved-synthetic-origin',
      '--acknowledge-independent-synthetic-app-id'
    ], {
      cwd: projectRoot,
      env: childEnvironment,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      'Synthetic miniapp workspace prepared without network access.\n'
    );
    for (const forbidden of [SYNTHETIC_ORIGIN, SYNTHETIC_APP_ID, parent]) {
      assert.equal(result.stdout.includes(forbidden), false);
      assert.equal(result.stderr.includes(forbidden), false);
    }
    assert.equal(fs.existsSync(path.join(output, '.synthetic-workspace.json')), true);

    const rejected = spawnSync(process.execPath, [
      scriptFile,
      '--origin', SYNTHETIC_ORIGIN,
      '--app-id', SYNTHETIC_APP_ID,
      '--output', output,
      '--acknowledge-approved-synthetic-origin',
      '--acknowledge-independent-synthetic-app-id'
    ], {
      cwd: projectRoot,
      env: childEnvironment,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000
    });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stderr, 'Synthetic miniapp workspace preparation failed.\n');
    for (const forbidden of [SYNTHETIC_ORIGIN, SYNTHETIC_APP_ID, parent]) {
      assert.equal(rejected.stdout.includes(forbidden), false);
      assert.equal(rejected.stderr.includes(forbidden), false);
    }

    const privateTemp = path.join(parent, 'missing-private-temp-sentinel');
    const invalidTemp = spawnSync(process.execPath, [
      scriptFile,
      '--origin', SYNTHETIC_ORIGIN,
      '--app-id', SYNTHETIC_APP_ID,
      '--output', path.join(privateTemp, 'miniapp-output'),
      '--acknowledge-approved-synthetic-origin',
      '--acknowledge-independent-synthetic-app-id'
    ], {
      cwd: projectRoot,
      env: { ...childEnvironment, TEMP: privateTemp, TMP: privateTemp },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000
    });
    assert.equal(invalidTemp.status, 1);
    assert.equal(invalidTemp.stderr, 'Synthetic miniapp workspace preparation failed.\n');
    assert.equal(invalidTemp.stderr.includes(privateTemp), false);
    assert.equal(invalidTemp.stderr.includes(projectRoot), false);
  });
});
