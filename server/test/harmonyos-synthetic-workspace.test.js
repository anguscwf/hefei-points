const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const scriptFile = path.join(projectRoot, 'scripts', 'prepare-harmonyos-synthetic-workspace.js');
const environmentFile = path.join(
  projectRoot,
  'hefei-harmonyos', 'entry', 'src', 'main', 'ets', 'config', 'ApiEnvironment.ets'
);
const workspace = require('../../scripts/prepare-harmonyos-synthetic-workspace');
const SAFE_GIT_PREFIX = [
  '--no-pager', '--no-optional-locks', '--no-replace-objects', '-c', 'core.fsmonitor=false',
  '-c', `safe.directory=${fs.realpathSync.native(projectRoot)}`
];

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
    maxBuffer: 64 * 1024 * 1024,
    ...options
  });
}

function selectedTrackedEntries() {
  const output = git(['ls-files', '--stage', '-z', '--', 'hefei-harmonyos'], {
    encoding: 'utf8'
  });
  return output.split('\0').filter(Boolean).map(record => {
    const match = /^(100644|100755) ([0-9a-f]{40,64}) 0\t(.+)$/.exec(record);
    assert.ok(match, record);
    return { mode: match[1], oid: match[2], filename: match[3] };
  }).sort((left, right) => (left.filename < right.filename ? -1 : (left.filename > right.filename ? 1 : 0)));
}

function selectedTrackedFiles() {
  return selectedTrackedEntries().map(entry => entry.filename);
}

function indexInputs(files) {
  const entries = selectedTrackedEntries();
  assert.deepEqual(entries.map(entry => entry.filename), files);
  const output = git(['cat-file', '--batch'], {
    encoding: null,
    input: `${entries.map(entry => entry.oid).join('\n')}\n`
  });
  const inputs = [];
  let offset = 0;
  for (const entry of entries) {
    const filename = entry.filename;
    const headerEnd = output.indexOf(0x0a, offset);
    const match = /^([0-9a-f]{40,64}) blob ([0-9]+)$/.exec(
      output.subarray(offset, headerEnd).toString('utf8')
    );
    assert.ok(match, filename);
    assert.equal(match[1], entry.oid, filename);
    const length = Number(match[2]);
    const start = headerEnd + 1;
    const end = start + length;
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

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function withTemporaryParent(work) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tangguan-synthetic-workspace-'));
  try {
    return work(parent);
  } finally {
    const resolved = path.resolve(parent);
    assert.equal(resolved.startsWith(path.resolve(os.tmpdir())), true);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

function filesIn(directory, root = directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesIn(filename, root));
    else files.push(path.relative(root, filename));
  }
  return files;
}

test('合成 HarmonyOS origin 只接受 canonical 公共 HTTPS 且拒绝生产源', () => {
  assert.equal(workspace.canonicalHttpsOrigin('https://synthetic-api.example.com'), true);
  for (const origin of [
    'http://synthetic-api.example.com',
    'https://SYNTHETIC-api.example.com',
    'https://user@synthetic-api.example.com',
    'https://synthetic-api.example.com:443',
    'https://synthetic-api.example.com/',
    'https://synthetic-api.example.com/path',
    'https://synthetic-api.example.com?mode=test',
    'https://127.0.0.1',
    'https://harmony-child.invalid',
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
});

test('合成 workspace 参数要求显式批准确认且拒绝覆盖与仓库内输出', () => {
  assert.deepEqual(workspace.parseArguments([
    '--origin', 'https://synthetic-api.example.com',
    '--output', 'C:\\synthetic-output',
    '--acknowledge-approved-synthetic-origin'
  ]), {
    origin: 'https://synthetic-api.example.com',
    output: 'C:\\synthetic-output',
    acknowledged: true,
    help: false
  });
  assert.throws(() => workspace.parseArguments(['--unknown']), /unknown argument/);
  if (process.platform === 'win32') {
    assert.throws(
      () => workspace.resolveOutput('\\\\synthetic-host\\share\\workspace'),
      /local temporary directory/
    );
  }
  assert.throws(
    () => workspace.prepareWorkspace({
      origin: 'https://synthetic-api.example.com',
      output: path.join(projectRoot, 'synthetic-output'),
      acknowledged: true
    }),
    /outside the canonical repository/
  );
  withTemporaryParent(parent => {
    const existing = path.join(parent, 'existing');
    fs.mkdirSync(existing);
    assert.throws(
      () => workspace.prepareWorkspace({
        origin: 'https://synthetic-api.example.com',
        output: existing,
        acknowledged: true
      }),
      /must not already exist/
    );
    assert.throws(
      () => workspace.prepareWorkspace({
        origin: 'https://synthetic-api.example.com',
        output: path.join(parent, 'missing-ack'),
        acknowledged: false
      }),
      /acknowledgement is required/
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

test('只接受普通 Git 文件模式，拒绝符号链接与子模块输入', () => {
  assert.deepEqual(workspace.parseTrackedEntries(
    `100644 ${'a'.repeat(40)} 0\thefei-harmonyos/entry/oh-package.json5\0`
  ), ['hefei-harmonyos/entry/oh-package.json5']);
  assert.throws(
    () => workspace.parseTrackedEntries(
      `120000 ${'b'.repeat(40)} 0\thefei-harmonyos/private-link\0`
    ),
    /only regular files/
  );
  assert.throws(
    () => workspace.parseTrackedEntries(
      `160000 ${'c'.repeat(40)} 0\thefei-harmonyos/nested-project\0`
    ),
    /only regular files/
  );
  for (const filename of [
    'hefei-harmonyos/entry/src/main/ets/CON.ets',
    'hefei-harmonyos/entry/src/main/ets/AUX.ets',
    'hefei-harmonyos/entry/src/main/ets/alias:stream.ets',
    'hefei-harmonyos/entry/src/main/ets/trailing.ets.',
    'hefei-harmonyos/entry\\src\\main\\ets\\backslash.ets',
    'hefei-harmonyos/entry/src/main/ets/control\u0001.ets',
    'hefei-harmonyos/entry/src/main/.git/config.json'
  ]) {
    assert.throws(
      () => workspace.selectHarmonyFiles([filename]),
      /forbidden path|signing artifact/
    );
  }
  assert.throws(
    () => workspace.selectHarmonyFiles([
      'hefei-harmonyos/entry/src/main/ets/Alias.ets',
      'hefei-harmonyos/entry/src/main/ets/alias.ets'
    ]),
    /platform path alias/
  );

  withTemporaryParent(parent => {
    const source = path.join(parent, 'source');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(source);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(source, 'regular.txt'), 'synthetic regular input');
    fs.writeFileSync(path.join(outside, 'private.txt'), 'synthetic private canary');
    assert.equal(
      workspace.readRegularFileWithin(source, 'regular.txt').toString('utf8'),
      'synthetic regular input'
    );
    fs.symlinkSync(
      outside,
      path.join(source, 'linked-directory'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    assert.throws(
      () => workspace.readRegularFileWithin(source, 'linked-directory/private.txt'),
      /real regular files/
    );
  });
});

test('只复制跟踪工程并在仓库外生成 unsigned 合成 profile', () => {
  withTemporaryParent(parent => {
    const output = path.join(parent, 'harmony-synthetic');
    const originalEnvironment = fs.readFileSync(environmentFile, 'utf8');
    workspace.prepareWorkspace({
      origin: 'https://synthetic-api.example.com',
      output,
      acknowledged: true
    });
    assert.equal(fs.readFileSync(environmentFile, 'utf8'), originalEnvironment);

    const generatedEnvironment = fs.readFileSync(path.join(
      output, 'entry', 'src', 'main', 'ets', 'config', 'ApiEnvironment.ets'
    ), 'utf8');
    assert.match(generatedEnvironment, /PROFILE: string = 'synthetic-approved'/);
    assert.match(generatedEnvironment, /NETWORK_ENABLED: boolean = true/);
    assert.match(generatedEnvironment, /API_ORIGIN: string = 'https:\/\/synthetic-api\.example\.com'/);
    assert.doesNotMatch(generatedEnvironment, /hefeijifen\.cn/);

    const buildProfile = fs.readFileSync(path.join(output, 'build-profile.json5'), 'utf8');
    assert.match(buildProfile, /"signingConfigs": \[\]/);
    assert.doesNotMatch(buildProfile, /password|certificate|profileFile|signAlg/i);

    const manifest = JSON.parse(fs.readFileSync(
      path.join(output, '.synthetic-workspace.json'), 'utf8'
    ));
    const selectedFiles = selectedTrackedFiles();
    const sourceInputs = indexInputs(selectedFiles);
    const generatedFilesWithoutManifest = filesIn(output)
      .map(value => value.split(path.sep).join('/'))
      .filter(value => value !== '.synthetic-workspace.json')
      .sort((left, right) => left.localeCompare(right));
    const generatedInputs = generatedFilesWithoutManifest.map(filename => ({
      filename,
      content: fs.readFileSync(path.join(output, ...filename.split('/')))
    }));
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.projectType, 'harmonyos');
    assert.equal(manifest.profile, 'synthetic-approved');
    assert.equal(manifest.origin, 'https://synthetic-api.example.com');
    assert.match(manifest.sourceCommit, /^[0-9a-f]{40,64}$/);
    assert.equal(
      manifest.sourceCommit,
      git(['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim()
    );
    assert.equal(manifest.sourceTreeSha256, framedDigest(sourceInputs));
    assert.equal(manifest.auditedSourceTreeRequired, true);
    assert.equal(manifest.auditedSourceTreeSha256, manifest.sourceTreeSha256);
    assert.equal(manifest.generatedTreeSha256, framedDigest(generatedInputs));
    assert.equal(manifest.clientSourceIndexMatchesHead, true);
    assert.equal(manifest.clientSourceWorktreeInspected, false);
    assert.equal(manifest.clientSourceWorktreeUsed, false);
    assert.equal(manifest.sourceSelectedTrackedFileCount, selectedFiles.length);
    assert.equal(
      manifest.sourceSelectedTrackedFilesSha256,
      sha256(Buffer.from(selectedFiles.join('\0'), 'utf8'))
    );
    for (const field of [
      'trackedFilesOnly',
      'unsigned',
      'temporaryWorkspace',
      'requiresExternalInfrastructureApproval'
    ]) assert.equal(manifest[field], true, field);
    for (const field of [
      'privateRootBuildProfileCopied',
      'infrastructureConnectivityVerified',
      'dnsVerified',
      'tlsVerified',
      'adultDeviceSmokeVerified',
      'huksAssetStoreRuntimeVerified',
      'devEcoInvoked',
      'buildPerformed',
      'signingPerformed'
    ]) assert.equal(manifest[field], false, field);
    assert.deepEqual(manifest.patchedFiles.map(item => item.path), [
      'entry/src/main/ets/config/ApiEnvironment.ets',
      'build-profile.json5'
    ]);
    for (const patched of manifest.patchedFiles) {
      assert.equal(
        patched.sha256,
        sha256(fs.readFileSync(path.join(output, ...patched.path.split('/'))))
      );
    }
    assert.deepEqual(manifest.implementationFiles.map(item => item.path), [
      'scripts/prepare-harmonyos-synthetic-workspace.js'
    ]);
    assert.equal(
      manifest.implementationFiles[0].sha256,
      sha256(fs.readFileSync(scriptFile))
    );

    const generatedFiles = filesIn(output).map(value => value.split(path.sep).join('/'));
    assert.equal(generatedFiles.some(value => value.startsWith('.git/')), false);
    assert.equal(generatedFiles.some(value => /\.(?:p12|pfx|cer|pem|key)$/i.test(value)), false);
  });
});

test('生成中途失败不留下最终目录或半成品 staging', () => {
  withTemporaryParent(parent => {
    const output = path.join(parent, 'harmony-synthetic-failure');
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = function(filename, ...args) {
      if (path.basename(String(filename)) === '.synthetic-workspace.json') {
        throw new Error('synthetic injected manifest failure');
      }
      return originalWrite.call(fs, filename, ...args);
    };
    try {
      assert.throws(() => workspace.prepareWorkspace({
        origin: 'https://synthetic-api.example.com',
        output,
        acknowledged: true
      }), /synthetic injected manifest failure/);
    } finally {
      fs.writeFileSync = originalWrite;
    }
    assert.equal(fs.existsSync(output), false);
    assert.equal(
      fs.readdirSync(parent).some(name => name.startsWith('.tangguan-harmony-stage-')),
      false
    );
  });
});

test('原子发布 rename 是成功路径最后一次文件系统操作', () => {
  withTemporaryParent(parent => {
    const output = path.join(parent, 'harmony-synthetic-atomic-publish');
    const originals = new Map();
    let published = false;
    const originalRename = fs.renameSync;
    fs.renameSync = function(from, to) {
      if (published) throw new Error('post-publish filesystem operation: renameSync');
      const result = originalRename.call(fs, from, to);
      if (path.resolve(String(to)) === path.resolve(output)) published = true;
      return result;
    };
    for (const name of [
      'existsSync', 'lstatSync', 'statSync', 'readFileSync', 'readdirSync', 'realpathSync',
      'writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'copyFileSync',
      'chmodSync', 'openSync'
    ]) {
      const original = fs[name];
      originals.set(name, original);
      fs[name] = function(filename, ...args) {
        if (published) throw new Error(`post-publish filesystem operation: ${name}`);
        return original.call(fs, filename, ...args);
      };
    }
    try {
      assert.equal(workspace.prepareWorkspace({
        origin: 'https://synthetic-api.example.com',
        output,
        acknowledged: true
      }), output);
      assert.equal(published, true);
    } finally {
      fs.renameSync = originalRename;
      for (const [name, original] of originals) fs[name] = original;
    }
    assert.equal(fs.existsSync(path.join(output, '.synthetic-workspace.json')), true);
    assert.equal(
      fs.readdirSync(parent).some(name => name.startsWith('.tangguan-harmony-stage-')),
      false
    );
  });
});

test('CLI 准备过程不联网且输出不回显 origin 或本机路径', () => {
  withTemporaryParent(parent => {
    const output = path.join(parent, 'cli-harmony-synthetic');
    const networkGuard = path.join(parent, 'deny-node-network.cjs');
    const expectedBatchInput = `${selectedTrackedEntries().map(entry => entry.oid).join('\n')}\n`;
    fs.writeFileSync(networkGuard, [
      "const deny = () => { throw new Error('EXTERNAL_IO_DISABLED_BY_TEST'); };",
      "const net = require('node:net');",
      'net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny;',
      "const dns = require('node:dns');",
      'dns.lookup = deny; dns.resolve = deny; dns.resolve4 = deny; dns.resolve6 = deny;',
      'dns.Resolver.prototype.resolve = deny; dns.Resolver.prototype.resolve4 = deny; dns.Resolver.prototype.resolve6 = deny;',
      "const http = require('node:http'); const https = require('node:https');",
      'http.request = deny; http.get = deny; http.ClientRequest = deny; https.request = deny; https.get = deny;',
      "const tls = require('node:tls'); const http2 = require('node:http2');",
      'tls.connect = deny; http2.connect = deny;',
      "const dgram = require('node:dgram');",
      'dgram.createSocket = deny;',
      'if (dns.promises) {',
      '  dns.promises.lookup = deny; dns.promises.resolve = deny;',
      '  dns.promises.resolve4 = deny; dns.promises.resolve6 = deny;',
      '}',
      'globalThis.fetch = deny;',
      "const path = require('node:path'); const fs = require('node:fs');",
      `const canonicalRoot = ${JSON.stringify(projectRoot)};`,
      `const harmonyRoot = ${JSON.stringify(path.join(projectRoot, 'hefei-harmonyos'))};`,
      "const privateName = /(?:^|[\\\\/])(?:\\.env(?:$|\\.)|build-profile\\.json5$|project\\.private\\.config\\.json$)/i;",
      'const forbiddenRead = filename => {',
      '  const resolved = path.resolve(String(filename));',
      '  return resolved === harmonyRoot || resolved.startsWith(harmonyRoot + path.sep)',
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
      `const expectedCwd = ${JSON.stringify(projectRoot)};`,
      `const expectedBatchInput = ${JSON.stringify(expectedBatchInput)};`,
      `const allowedGitCommands = new Set(${JSON.stringify([
        ['rev-parse', '--show-toplevel'],
        ['rev-parse', '--verify', 'HEAD'],
        ['ls-files', '--stage', '-z', '--', 'hefei-harmonyos'],
        ['ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', 'hefei-harmonyos'],
        ['cat-file', '--batch']
      ].map(value => JSON.stringify(value)))});`,
      'child.execFileSync = function(file, args, options) {',
      "  const prefixMatches = file === 'git' && Array.isArray(args)",
      '    && expectedGitPrefix.every((value, index) => args[index] === value);',
      '  const command = prefixMatches ? args.slice(expectedGitPrefix.length) : [];',
      '  const environment = options && options.env || {};',
      '  const forbiddenEnvironment = Object.keys(environment).some(key => /^(?:GIT_TRACE|GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_|VALUE_)|GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|REPLACE_REF_BASE|NAMESPACE))/i.test(key));',
      "  const secretEnvironmentPresent = Object.prototype.hasOwnProperty.call(environment, 'WX_APPSECRET')",
      "    || Object.prototype.hasOwnProperty.call(environment, 'SYNTHETIC_GIT_ENV_CANARY');",
      "  const batchInputValid = command[0] !== 'cat-file' || options.input === expectedBatchInput;",
      '  const allowed = prefixMatches && allowedGitCommands.has(JSON.stringify(command))',
      "    && environment.GIT_NO_LAZY_FETCH === '1'",
      "    && environment.GIT_NO_REPLACE_OBJECTS === '1'",
      "    && environment.GIT_OPTIONAL_LOCKS === '0'",
      "    && environment.GIT_CONFIG_NOSYSTEM === '1'",
      "    && environment.GIT_ATTR_NOSYSTEM === '1'",
      "    && environment.GIT_PROTOCOL_FROM_USER === '0'",
      "    && environment.GIT_TERMINAL_PROMPT === '0'",
      '    && options.cwd === expectedCwd && batchInputValid',
      '    && !forbiddenEnvironment && !secretEnvironmentPresent;',
      '  if (!allowed) return deny();',
      '  return originalExecFileSync.call(child, file, args, options);',
      '};',
      'child.exec = deny; child.execSync = deny; child.execFile = deny;',
      'child.spawn = deny; child.spawnSync = deny; child.fork = deny;'
    ].join('\n'));
    const nodeOptions = `--require=${networkGuard.split(path.sep).join('/')}`;
    const childEnvironment = {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      SYNTHETIC_GIT_ENV_CANARY: 'must-not-enter-git-child',
      WX_APPSECRET: 'synthetic-parent-secret-must-not-enter-git-child'
    };
    const result = spawnSync(process.execPath, [
      scriptFile,
      '--origin', 'https://synthetic-api.example.com',
      '--output', output,
      '--acknowledge-approved-synthetic-origin'
    ], {
      cwd: projectRoot,
      env: childEnvironment,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      'Synthetic HarmonyOS workspace prepared without network access.\n'
    );
    assert.equal(result.stdout.includes('synthetic-api.example.com'), false);
    assert.equal(result.stdout.includes(parent), false);
    assert.equal(fs.existsSync(path.join(output, '.synthetic-workspace.json')), true);

    const rejected = spawnSync(process.execPath, [
      scriptFile,
      '--origin', 'https://synthetic-api.example.com',
      '--output', output,
      '--acknowledge-approved-synthetic-origin'
    ], {
      cwd: projectRoot,
      env: childEnvironment,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000
    });
    assert.equal(rejected.status, 1);
    assert.equal(
      rejected.stderr,
      'Synthetic HarmonyOS workspace preparation failed.\n'
    );
    assert.equal(rejected.stderr.includes('synthetic-api.example.com'), false);
    assert.equal(rejected.stderr.includes(parent), false);

    const privateTemp = path.join(parent, 'missing-private-temp-sentinel');
    const invalidTemp = spawnSync(process.execPath, [
      scriptFile,
      '--origin', 'https://synthetic-api.example.com',
      '--output', path.join(privateTemp, 'harmony-output'),
      '--acknowledge-approved-synthetic-origin'
    ], {
      cwd: projectRoot,
      env: { ...childEnvironment, TEMP: privateTemp, TMP: privateTemp },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000
    });
    assert.equal(invalidTemp.status, 1);
    assert.equal(invalidTemp.stderr, 'Synthetic HarmonyOS workspace preparation failed.\n');
    assert.equal(invalidTemp.stderr.includes(privateTemp), false);
    assert.equal(invalidTemp.stderr.includes(projectRoot), false);
  });
});
