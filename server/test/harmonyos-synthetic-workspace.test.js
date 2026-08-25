const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const scriptFile = path.join(projectRoot, 'scripts', 'prepare-harmonyos-synthetic-workspace.js');
const environmentFile = path.join(
  projectRoot,
  'hefei-harmonyos', 'entry', 'src', 'main', 'ets', 'config', 'ApiEnvironment.ets'
);
const workspace = require('../../scripts/prepare-harmonyos-synthetic-workspace');

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
    assert.deepEqual({
      schemaVersion: manifest.schemaVersion,
      profile: manifest.profile,
      origin: manifest.origin,
      sourceTreeSha256: manifest.sourceTreeSha256,
      sourceTrackedChanges: manifest.sourceTrackedChanges,
      trackedFilesOnly: manifest.trackedFilesOnly,
      unsigned: manifest.unsigned,
      temporaryWorkspace: manifest.temporaryWorkspace,
      requiresExternalInfrastructureApproval: manifest.requiresExternalInfrastructureApproval
    }, {
      schemaVersion: 1,
      profile: 'synthetic-approved',
      origin: 'https://synthetic-api.example.com',
      sourceTreeSha256: manifest.sourceTreeSha256,
      sourceTrackedChanges: manifest.sourceTrackedChanges,
      trackedFilesOnly: true,
      unsigned: true,
      temporaryWorkspace: true,
      requiresExternalInfrastructureApproval: true
    });
    assert.match(manifest.sourceCommit, /^[0-9a-f]{40}$/);
    assert.match(manifest.sourceTreeSha256, /^[0-9a-f]{64}$/);
    assert.equal(typeof manifest.sourceTrackedChanges, 'boolean');

    const generatedFiles = filesIn(output).map(value => value.split(path.sep).join('/'));
    assert.equal(generatedFiles.some(value => value.startsWith('.git/')), false);
    assert.equal(generatedFiles.some(value => /\.(?:p12|pfx|cer|pem|key)$/i.test(value)), false);
  });
});

test('CLI 准备过程不联网且输出不回显 origin 或本机路径', () => {
  withTemporaryParent(parent => {
    const output = path.join(parent, 'cli-harmony-synthetic');
    const networkGuard = path.join(parent, 'deny-node-network.cjs');
    fs.writeFileSync(networkGuard, [
      "const deny = () => { throw new Error('NETWORK_DISABLED_BY_TEST'); };",
      "const net = require('node:net');",
      'net.connect = deny; net.createConnection = deny;',
      "const dns = require('node:dns');",
      'dns.lookup = deny; dns.resolve = deny; dns.resolve4 = deny; dns.resolve6 = deny;',
      "const http = require('node:http'); const https = require('node:https');",
      'http.request = deny; http.get = deny; https.request = deny; https.get = deny;',
      "const tls = require('node:tls'); const http2 = require('node:http2');",
      'tls.connect = deny; http2.connect = deny;',
      "const dgram = require('node:dgram');",
      'dgram.createSocket = deny;',
      'if (dns.promises) {',
      '  dns.promises.lookup = deny; dns.promises.resolve = deny;',
      '  dns.promises.resolve4 = deny; dns.promises.resolve6 = deny;',
      '}',
      'globalThis.fetch = deny;'
    ].join('\n'));
    const nodeOptions = `--require=${networkGuard.split(path.sep).join('/')}`;
    const result = spawnSync(process.execPath, [
      scriptFile,
      '--origin', 'https://synthetic-api.example.com',
      '--output', output,
      '--acknowledge-approved-synthetic-origin'
    ], {
      cwd: projectRoot,
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
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
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
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
  });
});
