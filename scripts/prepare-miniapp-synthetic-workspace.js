const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const miniappCheck = require('./check-miniapp');
const harmonyWorkspace = require('./prepare-harmonyos-synthetic-workspace');

const projectRoot = path.resolve(__dirname, '..');
const realpathSync = fs.realpathSync.native || fs.realpathSync;
const miniappPrefix = 'hefei-miniapp/';
const environmentFile = 'hefei-miniapp/utils/runtime-environment.js';
const projectConfigFile = 'hefei-miniapp/project.config.json';
const auditedRuntimeEnvironmentSha256 = 'e64c1c3b7a80df66ad2c1d945b66fa75c5b8e7c8c8fafe35a0f166cee5749782';
const auditedMiniappSourceTreeSha256 = 'efd413a4ccd7a04712c0e735575b29f3fb48ff90ac44e37d396559f11a8745ef';
const allowedProjectExtensions = new Set([
  '.js', '.json', '.png', '.svg', '.wxml', '.wxss'
]);
const explicitlyExcludedTrackedFiles = new Set(['hefei-miniapp/README.md']);
const implementationFiles = [
  'scripts/prepare-miniapp-synthetic-workspace.js',
  'scripts/check-miniapp.js',
  'scripts/prepare-harmonyos-synthetic-workspace.js'
];

function runtimeRoots() {
  const projectRealRoot = realpathSync(projectRoot);
  const temporaryRootValue = os.tmpdir();
  if (!path.isAbsolute(temporaryRootValue)
      || (process.platform === 'win32'
        && temporaryRootValue.replaceAll('/', '\\').startsWith('\\\\'))) {
    throw new Error('system temporary directory must be a local absolute path');
  }
  const temporaryRoot = path.resolve(temporaryRootValue);
  const metadata = fs.lstatSync(temporaryRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('system temporary directory must be a real local directory');
  }
  return Object.freeze({
    projectRealRoot,
    temporaryRealRoot: realpathSync(temporaryRoot)
  });
}

function readOnlyGitPrefix() {
  const { projectRealRoot } = runtimeRoots();
  return [
    '--no-pager',
    '--no-optional-locks',
    '--no-replace-objects',
    '-c', 'core.fsmonitor=false',
    '-c', `safe.directory=${projectRealRoot.split(path.sep).join('/')}`
  ];
}

function parseArguments(argv) {
  const result = {
    origin: '',
    output: '',
    appId: '',
    acknowledgedOrigin: false,
    acknowledgedAppId: false,
    help: false
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      if (seen.has(argument)) throw new Error('duplicate argument');
      seen.add(argument);
      result.help = true;
      continue;
    }
    if (argument === '--acknowledge-approved-synthetic-origin'
        || argument === '--acknowledge-independent-synthetic-app-id') {
      if (seen.has(argument)) throw new Error('duplicate argument');
      seen.add(argument);
      if (argument === '--acknowledge-approved-synthetic-origin') {
        result.acknowledgedOrigin = true;
      } else {
        result.acknowledgedAppId = true;
      }
      continue;
    }
    if (argument !== '--origin' && argument !== '--output' && argument !== '--app-id') {
      throw new Error('unknown argument');
    }
    if (seen.has(argument)) throw new Error('duplicate argument');
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('missing argument value');
    index += 1;
    if (argument === '--origin') result.origin = value;
    else if (argument === '--output') result.output = value;
    else result.appId = value;
  }
  return result;
}

function validateSyntheticAppId(value, canonicalAppId = '') {
  if (typeof value !== 'string' || !/^wx[a-f0-9]{16}$/.test(value)) {
    throw new Error('synthetic app id must use the canonical WeChat AppID format');
  }
  if (canonicalAppId && value === canonicalAppId) {
    throw new Error('synthetic app id must be independent from the canonical project app id');
  }
  return value;
}

function isWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function assertCanonicalGitRoot() {
  const { projectRealRoot } = runtimeRoots();
  const gitRoot = gitText(['rev-parse', '--show-toplevel']);
  if (!gitRoot || path.relative(projectRealRoot, realpathSync(gitRoot)) !== '') {
    throw new Error('synthetic miniapp workspace must use the canonical repository');
  }
}

function readOnlyGitEnvironment() {
  const environment = {};
  const inherited = new Set([
    'COMSPEC', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'PATHEXT',
    'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'WINDIR'
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (inherited.has(key.toUpperCase()) && typeof value === 'string') {
      environment[key] = value;
    }
  }
  environment.GIT_ATTR_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : os.devNull;
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_NO_LAZY_FETCH = '1';
  environment.GIT_NO_REPLACE_OBJECTS = '1';
  environment.GIT_PROTOCOL_FROM_USER = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

function readOnlyGitArguments(arguments_) {
  return [...readOnlyGitPrefix(), ...arguments_];
}

function gitText(arguments_) {
  return execFileSync('git', readOnlyGitArguments(arguments_), {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: readOnlyGitEnvironment()
  }).trim();
}

function selectTrackedMiniappFiles(tracked) {
  const files = [];
  for (const filename of tracked) {
    if (explicitlyExcludedTrackedFiles.has(filename)) continue;
    if (!allowedProjectExtensions.has(path.extname(filename).toLowerCase())) {
      throw new Error('tracked miniapp project contains an unaudited file type');
    }
    files.push(filename);
  }
  return files.sort();
}

function indexedMiniappEntries() {
  const output = execFileSync(
    'git', readOnlyGitArguments(['ls-files', '--stage', '-z', '--', 'hefei-miniapp']),
    {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
      env: readOnlyGitEnvironment()
    }
  );
  const filenames = miniappCheck.parseTrackedMiniappEntries(output);
  const records = output.split('\0').filter(Boolean);
  return records.map((record, index) => {
    const match = /^(100644|100755) ([0-9a-f]{40,64}) 0\t(.+)$/.exec(record);
    if (!match || match[3] !== filenames[index]) {
      throw new Error('tracked miniapp index entry is malformed');
    }
    return { mode: match[1], oid: match[2], filename: match[3] };
  });
}

function committedMiniappEntries() {
  const output = execFileSync(
    'git', readOnlyGitArguments([
      'ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', 'hefei-miniapp'
    ]),
    {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
      env: readOnlyGitEnvironment()
    }
  );
  const records = output.split('\0').filter(Boolean);
  const entries = records.map(record => {
    const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/.exec(record);
    if (!match) throw new Error('committed miniapp tree must contain only regular files');
    return { mode: match[1], oid: match[2], filename: match[3] };
  });
  miniappCheck.parseTrackedMiniappEntries(entries.map(entry => (
    `${entry.mode} ${entry.oid} 0\t${entry.filename}\0`
  )).join(''));
  return entries;
}

function entrySignature(entries) {
  return entries.map(entry => `${entry.mode} ${entry.oid}\t${entry.filename}`).join('\0');
}

function trackedMiniappEntries() {
  assertCanonicalGitRoot();
  const indexed = indexedMiniappEntries();
  const committed = committedMiniappEntries();
  if (entrySignature(indexed) !== entrySignature(committed)) {
    throw new Error('tracked miniapp index must match the committed HEAD tree');
  }
  const files = selectTrackedMiniappFiles(indexed.map(entry => entry.filename));
  if (!files.includes(environmentFile) || !files.includes(projectConfigFile)) {
    throw new Error('tracked miniapp project is incomplete');
  }
  if (files.length === 0) throw new Error('tracked miniapp project is empty');
  const byName = new Map(indexed.map(entry => [entry.filename, entry]));
  return files.map(filename => byName.get(filename));
}

function trackedMiniappFiles() {
  return trackedMiniappEntries().map(entry => entry.filename);
}

function trackedInputs(files, entries = trackedMiniappEntries()) {
  if (files.join('\0') !== entries.map(entry => entry.filename).join('\0')) {
    throw new Error('tracked miniapp file selection changed before blob read');
  }
  const output = execFileSync('git', readOnlyGitArguments(['cat-file', '--batch']), {
    cwd: projectRoot,
    encoding: null,
    windowsHide: true,
    env: readOnlyGitEnvironment(),
    input: `${entries.map(entry => entry.oid).join('\n')}\n`,
    maxBuffer: 64 * 1024 * 1024
  });
  const inputs = [];
  let offset = 0;
  for (const entry of entries) {
    const filename = entry.filename;
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error('tracked miniapp blob response is incomplete');
    const header = output.subarray(offset, headerEnd).toString('utf8');
    const match = /^([0-9a-f]{40,64}) blob ([0-9]+)$/.exec(header);
    if (!match || match[1] !== entry.oid) {
      throw new Error('tracked miniapp input must resolve to the captured blob');
    }
    const length = Number(match[2]);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + length;
    if (!Number.isSafeInteger(length) || length < 0 || contentEnd >= output.length
        || output[contentEnd] !== 0x0a) {
      throw new Error('tracked miniapp blob response is malformed');
    }
    inputs.push({ filename, content: output.subarray(contentStart, contentEnd) });
    offset = contentEnd + 1;
  }
  if (offset !== output.length) throw new Error('tracked miniapp blob response has trailing data');
  return inputs;
}

function inputDigest(inputs) {
  const digest = crypto.createHash('sha256');
  for (const input of inputs) {
    digest.update(Buffer.from(`${input.filename}\0${input.content.length}\0`, 'utf8'));
    digest.update(input.content);
  }
  return digest.digest('hex');
}

function namesDigest(files) {
  return crypto.createHash('sha256').update(files.join('\0'), 'utf8').digest('hex');
}

function contentSha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function auditedRuntimeInput(content) {
  const source = content.toString('utf8');
  if (source.replace(/\r\n/g, '').includes('\r')) return false;
  return contentSha256(Buffer.from(source.replace(/\r\n/g, '\n'), 'utf8'))
    === auditedRuntimeEnvironmentSha256;
}

function syntheticRuntimeEnvironment(origin) {
  return `// Generated in a temporary synthetic-only workspace. Do not copy this file into canonical source.
var SYNTHETIC_API_BASE = '${origin}';
var BLOCKED_API_BASE = 'https://blocked.invalid';

function originParts(value) {
  if (typeof value !== 'string') return null;
  var match = /^https:\\/\\/([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(value);
  if (!match) return null;
  var hostname = match[1].toLowerCase().replace(/\\.+$/, '');
  if (!hostname || hostname.charAt(0) === '.' || hostname.indexOf('..') >= 0) return null;
  var port = match[2] || '';
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
  return { hostname: hostname, port: port };
}

function normalizedOrigin(value) {
  var parts = originParts(value);
  if (!parts) return '';
  return 'https://' + parts.hostname
    + (parts.port && parts.port !== '443' ? ':' + parts.port : '');
}

function isProductionOrigin(value) {
  var parts = originParts(value);
  return !!parts && (parts.hostname === 'hefeijifen.cn'
    || /\\.hefeijifen\\.cn$/.test(parts.hostname));
}

function profile(value) {
  return typeof Object.freeze === 'function' ? Object.freeze(value) : value;
}

function blockedProfile(envVersion) {
  return profile({
    envVersion: envVersion,
    apiBase: BLOCKED_API_BASE,
    production: false,
    environmentReady: false,
    guardianPreviewEnabled: false,
    legalOrigin: BLOCKED_API_BASE,
    legalPathPrefix: '/legal/'
  });
}

function syntheticProfile(envVersion) {
  var apiBase = normalizedOrigin(SYNTHETIC_API_BASE);
  var ready = !!apiBase && !isProductionOrigin(apiBase) && !/\\.invalid$/i.test(apiBase);
  if (!ready) return blockedProfile(envVersion);
  return profile({
    envVersion: envVersion,
    apiBase: apiBase,
    production: false,
    environmentReady: true,
    guardianPreviewEnabled: true,
    legalOrigin: apiBase,
    legalPathPrefix: '/legal/'
  });
}

function resolve(envVersion) {
  if (envVersion === 'develop' || envVersion === 'trial') {
    return syntheticProfile(envVersion);
  }
  return blockedProfile(envVersion === 'release' ? 'release' : 'unknown');
}

module.exports = {
  resolve: resolve,
  isProductionOrigin: isProductionOrigin
};
`;
}

function generatedProjectConfig(source, appId) {
  let config;
  try {
    config = JSON.parse(source.toString('utf8'));
  } catch (_) {
    throw new Error('tracked miniapp project configuration is invalid');
  }
  if (!config || config.compileType !== 'miniprogram'
      || !config.setting || config.setting.urlCheck !== true
      || typeof config.appid !== 'string'
      || !config.packOptions || !Array.isArray(config.packOptions.ignore)
      || !Array.isArray(config.packOptions.include)
      || config.packOptions.ignore.length !== 0 || config.packOptions.include.length !== 0
      || !config.setting.babelSetting
      || config.setting.babelSetting.outputPath !== '') {
    throw new Error('tracked miniapp project configuration is unsafe');
  }
  for (const key of [
    'miniprogramRoot',
    'cloudfunctionRoot',
    'cloudbaseRoot',
    'pluginRoot',
    'qcloudRoot',
    'srcMiniprogramRoot'
  ]) {
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      throw new Error('tracked miniapp project configuration contains an external root');
    }
  }
  validateSyntheticAppId(appId, config.appid);
  config.appid = appId;
  config.projectname = 'hefei-points-synthetic';
  config.setting.urlCheck = true;
  config.setting.uploadWithSourceMap = false;
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function generatedInputs(inputs, origin, appId) {
  const byName = new Map(inputs.map(input => [input.filename, input]));
  const runtime = byName.get(environmentFile);
  const projectConfig = byName.get(projectConfigFile);
  if (!runtime || !projectConfig || !auditedRuntimeInput(runtime.content)) {
    throw new Error('tracked runtime environment differs from the audited template');
  }
  const generatedConfig = generatedProjectConfig(projectConfig.content, appId);
  return inputs.map(input => {
    if (input.filename === environmentFile) {
      return { filename: input.filename, content: Buffer.from(syntheticRuntimeEnvironment(origin)) };
    }
    if (input.filename === projectConfigFile) {
      return { filename: input.filename, content: generatedConfig };
    }
    return input;
  });
}

function resolveOutput(value) {
  const output = harmonyWorkspace.resolveOutput(value);
  const basename = path.basename(output);
  if (!basename || /[\u0000-\u001f\u007f:]/.test(basename) || /[. ]$/.test(basename)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(basename)) {
    throw new Error('output path must use a canonical local directory name');
  }
  return output;
}

function verifyTemporaryDirectory(directory) {
  const { projectRealRoot, temporaryRealRoot } = runtimeRoots();
  const metadata = fs.lstatSync(directory);
  const real = realpathSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || isWithin(projectRealRoot, real) || !isWithin(temporaryRealRoot, real)) {
    throw new Error('temporary staging directory is unsafe');
  }
  return real;
}

function writeGeneratedInputs(staging, inputs) {
  for (const input of inputs) {
    const target = path.join(staging, ...input.filename.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, input.content, { flag: 'wx' });
  }
}

function filesIn(directory, root = directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('generated workspace must not contain links');
    if (entry.isDirectory()) files.push(...filesIn(filename, root));
    else if (entry.isFile()) files.push(path.relative(root, filename).split(path.sep).join('/'));
    else throw new Error('generated workspace must contain only regular files');
  }
  return files.sort();
}

function verifyGeneratedFiles(staging, verificationInputs, expectedFiles) {
  const actualFiles = filesIn(staging);
  if (actualFiles.join('\0') !== expectedFiles.slice().sort().join('\0')) {
    throw new Error('generated workspace contains an unexpected file set');
  }
  for (const input of verificationInputs) {
    const filename = path.join(staging, ...input.filename.split('/'));
    if (!fs.readFileSync(filename).equals(input.content)) {
      throw new Error('generated workspace content verification failed');
    }
  }
}

function safeCleanup(staging) {
  if (!staging || !fs.existsSync(staging)) return;
  const real = verifyTemporaryDirectory(staging);
  if (!path.basename(real).startsWith('.tangguan-miniapp-stage-')) {
    throw new Error('refusing to clean an unexpected directory');
  }
  fs.rmSync(real, { recursive: true, force: true });
}

function implementationDigests() {
  return implementationFiles.map(filename => ({
    path: filename,
    sha256: contentSha256(fs.readFileSync(path.join(projectRoot, ...filename.split('/'))))
  }));
}

function prepareWorkspace(options) {
  if (!options || options.acknowledgedOrigin !== true) {
    throw new Error('explicit approved synthetic origin acknowledgement is required');
  }
  if (options.acknowledgedAppId !== true) {
    throw new Error('explicit independent synthetic app id acknowledgement is required');
  }
  const approvedOrigin = harmonyWorkspace.validateApprovedOrigin(options.origin);
  const destination = resolveOutput(options.output);
  assertCanonicalGitRoot();
  const sourceCommit = gitText(['rev-parse', '--verify', 'HEAD']);
  const sourceImplementationFiles = implementationDigests();
  const sourceEntries = trackedMiniappEntries();
  const files = sourceEntries.map(entry => entry.filename);
  const inputs = trackedInputs(files, sourceEntries);
  const sourceTreeSha256 = inputDigest(inputs);
  if (sourceTreeSha256 !== auditedMiniappSourceTreeSha256) {
    throw new Error('tracked miniapp source tree differs from the audited synthetic input');
  }
  const networkErrors = miniappCheck.checkNetworkDispatchBoundary(inputs);
  if (networkErrors.length) {
    throw new Error('tracked miniapp network boundary differs from the audited routes');
  }
  const generated = generatedInputs(inputs, approvedOrigin, options.appId);
  const generatedTreeSha256 = inputDigest(generated);
  let staging = '';
  try {
    staging = fs.mkdtempSync(path.join(path.dirname(destination), '.tangguan-miniapp-stage-'));
    verifyTemporaryDirectory(staging);
    writeGeneratedInputs(staging, generated);

    const finalCommit = gitText(['rev-parse', '--verify', 'HEAD']);
    const finalEntries = trackedMiniappEntries();
    const finalFiles = finalEntries.map(entry => entry.filename);
    const finalInputs = trackedInputs(finalFiles, finalEntries);
    const finalImplementationFiles = implementationDigests();
    if (sourceCommit !== finalCommit
        || files.join('\0') !== finalFiles.join('\0')
        || sourceTreeSha256 !== inputDigest(finalInputs)
        || JSON.stringify(sourceImplementationFiles) !== JSON.stringify(finalImplementationFiles)) {
      throw new Error('tracked miniapp source or generator implementation changed during preparation');
    }

    const manifest = {
      schemaVersion: 1,
      projectType: 'wechat-miniapp',
      profile: 'miniapp-synthetic-approved',
      sourceCommit,
      sourceTreeSha256,
      auditedSourceTreeRequired: true,
      auditedSourceTreeSha256: auditedMiniappSourceTreeSha256,
      clientSourceIndexMatchesHead: true,
      clientSourceWorktreeInspected: false,
      clientSourceWorktreeUsed: false,
      sourceSelectedTrackedFileCount: files.length,
      sourceSelectedTrackedFilesSha256: namesDigest(files),
      sourceExplicitlyExcludedTrackedFiles: [...explicitlyExcludedTrackedFiles].sort(),
      generatedTreeSha256,
      implementationFiles: sourceImplementationFiles,
      patchedFiles: [environmentFile, projectConfigFile].map(filename => ({
        path: filename,
        sha256: contentSha256(generated.find(input => input.filename === filename).content)
      })),
      origin: approvedOrigin,
      appIdSha256: contentSha256(Buffer.from(options.appId, 'utf8')),
      independentAppIdOperatorAcknowledged: true,
      independentAppIdStringDiffersFromCanonical: true,
      independentAppIdProvisioningVerified: false,
      developerAuthorizationVerified: false,
      trackedFilesOnly: true,
      sourcePrivateConfigCopied: false,
      temporaryWorkspace: true,
      developTrialSyntheticOnly: true,
      releaseFailClosed: true,
      unknownFailClosed: true,
      urlCheckRequired: true,
      uploadWithSourceMap: false,
      devToolsPrivateConfigVerified: false,
      requestDomainVerified: false,
      businessDomainVerified: false,
      infrastructureConnectivityVerified: false,
      devToolsInvoked: false,
      previewOrUploadPerformed: false,
      requiresExternalInfrastructureApproval: true
    };
    const manifestInput = {
      filename: '.synthetic-workspace.json',
      content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    };
    fs.writeFileSync(
      path.join(staging, manifestInput.filename),
      manifestInput.content,
      { flag: 'wx' }
    );
    const verificationInputs = [...generated, manifestInput];
    const expectedFiles = verificationInputs.map(input => input.filename);
    verifyGeneratedFiles(staging, verificationInputs, expectedFiles);
    verifyTemporaryDirectory(path.join(staging, 'hefei-miniapp'));
    if (fs.existsSync(destination)) throw new Error('output path must not already exist');
    // renameSync is deliberately the final fallible operation: a successful
    // publish is complete, and no path-based recursive rollback races a replaced destination.
    fs.renameSync(staging, destination);
    staging = '';
    return destination;
  } catch (error) {
    safeCleanup(staging);
    throw error;
  }
}

function usage() {
  return [
    'Usage:',
    '  node scripts/prepare-miniapp-synthetic-workspace.js',
    '    --origin https://approved-synthetic.example.com',
    '    --app-id wx0123456789abcdef',
    '    --output <new-directory-under-system-temp>',
    '    --acknowledge-approved-synthetic-origin',
    '    --acknowledge-independent-synthetic-app-id',
    '',
    'The command copies only committed miniapp project files into a temporary workspace.',
    'It never opens DevTools, previews, uploads, deploys or connects to the supplied origin.'
  ].join('\n');
}

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) process.stdout.write(`${usage()}\n`);
    else {
      prepareWorkspace(options);
      process.stdout.write('Synthetic miniapp workspace prepared without network access.\n');
    }
  } catch (_) {
    process.stderr.write('Synthetic miniapp workspace preparation failed.\n');
    process.exitCode = 1;
  }
}

module.exports = {
  auditedRuntimeInput,
  generatedInputs,
  inputDigest,
  parseArguments,
  prepareWorkspace,
  resolveOutput,
  selectTrackedMiniappFiles,
  syntheticRuntimeEnvironment,
  trackedMiniappFiles,
  validateSyntheticAppId,
  canonicalHttpsOrigin: harmonyWorkspace.canonicalHttpsOrigin,
  validateApprovedOrigin: harmonyWorkspace.validateApprovedOrigin
};
