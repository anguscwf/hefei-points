const fs = require('node:fs');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const realpathSync = fs.realpathSync.native || fs.realpathSync;
const harmonyPrefix = 'hefei-harmonyos/';
const auditedHarmonySourceTreeSha256 =
  'f3c306ff39903f92248f4cb9b14a9249eb83951d2ab5825d6ba1cf3c18b7e414';
const implementationFiles = Object.freeze([
  'scripts/prepare-harmonyos-synthetic-workspace.js'
]);
const environmentRelative = path.join(
  'entry', 'src', 'main', 'ets', 'config', 'ApiEnvironment.ets'
);
const allowedTrackedExtensions = new Set([
  '.ets', '.json', '.json5', '.md', '.png', '.ts', '.txt'
]);

function runtimeRoots() {
  const projectRealRoot = realpathSync(projectRoot);
  const temporaryRootValue = os.tmpdir();
  if (!path.isAbsolute(temporaryRootValue)
      || (process.platform === 'win32'
        && temporaryRootValue.replaceAll('/', '\\').startsWith('\\\\'))) {
    throw new Error('system temporary directory must be a local absolute path');
  }
  const temporaryRoot = path.resolve(temporaryRootValue);
  let temporaryRootMetadata;
  try {
    temporaryRootMetadata = fs.lstatSync(temporaryRoot);
  } catch (_) {
    throw new Error('system temporary directory is unavailable');
  }
  if (!temporaryRootMetadata.isDirectory() || temporaryRootMetadata.isSymbolicLink()) {
    throw new Error('system temporary directory must be a real local directory');
  }
  return Object.freeze({
    projectRealRoot,
    temporaryRoot,
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
    '-c', `safe.directory=${projectRealRoot}`
  ];
}

function parseArguments(argv) {
  const result = { origin: '', output: '', acknowledged: false, help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      result.help = true;
      continue;
    }
    if (argument === '--acknowledge-approved-synthetic-origin') {
      if (seen.has(argument)) throw new Error(`duplicate argument: ${argument}`);
      seen.add(argument);
      result.acknowledged = true;
      continue;
    }
    if (argument !== '--origin' && argument !== '--output') {
      throw new Error('unknown argument');
    }
    if (seen.has(argument)) throw new Error(`duplicate argument: ${argument}`);
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for ${argument}`);
    }
    index += 1;
    if (argument === '--origin') result.origin = value;
    else result.output = value;
  }
  return result;
}

function canonicalHttpsOrigin(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 261) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== value
      || parsed.username || parsed.password || parsed.port
      || parsed.pathname !== '/' || parsed.search || parsed.hash
      || parsed.hostname !== parsed.hostname.toLowerCase()
      || net.isIP(parsed.hostname) !== 0) {
    return false;
  }
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
    parsed.hostname
  )) {
    return false;
  }
  return !['.invalid', '.localhost', '.local', '.test'].some(
    suffix => parsed.hostname.endsWith(suffix)
  );
}

function validateApprovedOrigin(value) {
  if (!canonicalHttpsOrigin(value)) {
    throw new Error('origin must be a canonical public HTTPS origin without credentials, port, path, query or fragment');
  }
  const hostname = new URL(value).hostname;
  if (hostname === 'hefeijifen.cn' || hostname.endsWith('.hefeijifen.cn')) {
    throw new Error('production origin is forbidden');
  }
  return value;
}

function isWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveOutput(value) {
  const { projectRealRoot, temporaryRoot, temporaryRealRoot } = runtimeRoots();
  if (process.platform === 'win32' && value.replaceAll('/', '\\').startsWith('\\\\')) {
    throw new Error('output must stay inside the local temporary directory');
  }
  if (!path.isAbsolute(value)) throw new Error('output must be an absolute path');
  const output = path.resolve(value);
  const basename = path.basename(output);
  if (!basename || /[\u0000-\u001f\u007f:]/.test(basename) || /[. ]$/.test(basename)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(basename)) {
    throw new Error('output path must use a canonical local directory name');
  }
  if (isWithin(projectRoot, output)) {
    throw new Error('output must stay outside the canonical repository');
  }
  const parent = path.dirname(output);
  if (!isWithin(temporaryRoot, parent)) {
    throw new Error('output must stay inside the local temporary directory');
  }
  const parentRelative = path.relative(temporaryRoot, parent);
  let current = temporaryRoot;
  for (const segment of parentRelative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = fs.lstatSync(current);
    } catch (_) {
      throw new Error('output parent must already exist');
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('output parent must be a real local temporary directory');
    }
  }
  if (fs.existsSync(output)) throw new Error('output path must not already exist');
  let realParent;
  try {
    realParent = realpathSync(parent);
  } catch (_) {
    throw new Error('output parent must already exist');
  }
  if (isWithin(projectRealRoot, path.join(realParent, path.basename(output)))) {
    throw new Error('output must stay outside the canonical repository');
  }
  if (!isWithin(temporaryRealRoot, realParent)) {
    throw new Error('output must stay inside the local temporary directory');
  }
  return output;
}

function verifyCreatedOutput(output) {
  const { projectRealRoot, temporaryRealRoot } = runtimeRoots();
  const metadata = fs.lstatSync(output);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || isWithin(projectRealRoot, realpathSync(output))
      || !isWithin(temporaryRealRoot, realpathSync(output))) {
    throw new Error('created output must be a real directory outside the canonical repository');
  }
}

function parseTrackedEntries(output) {
  const records = output.split('\0').filter(Boolean);
  return records.map(record => {
    const match = /^(?:100644|100755) [0-9a-f]{40,64} 0\t(.+)$/.exec(record);
    if (!match) {
      throw new Error('tracked HarmonyOS input must contain only regular files');
    }
    return match[1];
  });
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

function assertCanonicalGitRoot() {
  const { projectRealRoot } = runtimeRoots();
  const gitRoot = gitText(['rev-parse', '--show-toplevel']);
  if (!gitRoot || path.relative(projectRealRoot, realpathSync(gitRoot)) !== '') {
    throw new Error('synthetic HarmonyOS workspace must use the canonical repository');
  }
}

function indexedHarmonyEntries() {
  const output = execFileSync(
    'git', readOnlyGitArguments(['ls-files', '--stage', '-z', '--', 'hefei-harmonyos']),
    {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
      env: readOnlyGitEnvironment()
    }
  );
  const files = parseTrackedEntries(output);
  return output.split('\0').filter(Boolean).map((record, index) => {
    const match = /^(100644|100755) ([0-9a-f]{40,64}) 0\t(.+)$/.exec(record);
    if (!match || match[3] !== files[index]) {
      throw new Error('tracked HarmonyOS index entry is malformed');
    }
    return { mode: match[1], oid: match[2], filename: match[3] };
  });
}

function committedHarmonyEntries() {
  const output = execFileSync(
    'git', readOnlyGitArguments([
      'ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', 'hefei-harmonyos'
    ]),
    {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
      env: readOnlyGitEnvironment()
    }
  );
  const entries = output.split('\0').filter(Boolean).map(record => {
    const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/.exec(record);
    if (!match) throw new Error('committed HarmonyOS tree must contain only regular files');
    return { mode: match[1], oid: match[2], filename: match[3] };
  });
  parseTrackedEntries(entries.map(entry => (
    `${entry.mode} ${entry.oid} 0\t${entry.filename}\0`
  )).join(''));
  return entries;
}

function entrySignature(entries) {
  return entries.map(entry => `${entry.mode} ${entry.oid}\t${entry.filename}`).join('\0');
}

function selectHarmonyFiles(files) {
  if (files.length === 0) throw new Error('tracked HarmonyOS project is empty');
  if (files.some(filename => (
    filename.toLowerCase() === 'hefei-harmonyos/build-profile.json5'
  ))) {
    throw new Error('private root build profile must not be tracked or copied');
  }
  const canonicalNames = new Set();
  for (const filename of files) {
    const segments = filename.split('/');
    const basename = segments[segments.length - 1];
    const extension = path.extname(filename).toLowerCase();
    if (!filename.startsWith(harmonyPrefix)
        || filename.normalize('NFC') !== filename
        || /[\\:\u0000-\u001f\u007f]/.test(filename)
        || path.posix.normalize(filename) !== filename
        || path.isAbsolute(filename)
        || segments.some(segment => !segment || segment === '.' || segment === '..'
          || segment.toLowerCase() === '.git' || /[. ]$/.test(segment)
          || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment))
        || (basename !== '.gitignore' && !allowedTrackedExtensions.has(extension))) {
      throw new Error('tracked HarmonyOS input contains a forbidden path or signing artifact');
    }
    const canonicalName = filename.toLowerCase();
    if (canonicalNames.has(canonicalName)) {
      throw new Error('tracked HarmonyOS input contains a platform path alias');
    }
    canonicalNames.add(canonicalName);
  }
  return files.slice().sort();
}

function trackedHarmonyEntries() {
  assertCanonicalGitRoot();
  const indexed = indexedHarmonyEntries();
  const committed = committedHarmonyEntries();
  if (entrySignature(indexed) !== entrySignature(committed)) {
    throw new Error('tracked HarmonyOS index must match the committed HEAD tree');
  }
  const files = selectHarmonyFiles(indexed.map(entry => entry.filename));
  const byName = new Map(indexed.map(entry => [entry.filename, entry]));
  return files.map(filename => byName.get(filename));
}

function trackedHarmonyFiles() {
  return trackedHarmonyEntries().map(entry => entry.filename);
}

function readRegularFileWithin(root, relative) {
  if (!relative || path.isAbsolute(relative)
      || relative.split(/[\\/]/).some(segment => segment === '..')) {
    throw new Error('tracked HarmonyOS input contains a forbidden path or signing artifact');
  }
  const rootMetadata = fs.lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('tracked HarmonyOS root must be a real directory');
  }
  const rootReal = realpathSync(root);
  const segments = relative.split('/');
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const metadata = fs.lstatSync(current);
    const final = index === segments.length - 1;
    if (metadata.isSymbolicLink()
        || (final ? !metadata.isFile() : !metadata.isDirectory())) {
      throw new Error('tracked HarmonyOS input must contain only real regular files');
    }
  }
  if (!isWithin(rootReal, realpathSync(current))) {
    throw new Error('tracked HarmonyOS input escaped the canonical HarmonyOS root');
  }
  return fs.readFileSync(current);
}

function trackedInputs(files, entries = trackedHarmonyEntries()) {
  if (files.join('\0') !== entries.map(entry => entry.filename).join('\0')) {
    throw new Error('tracked HarmonyOS file selection changed before blob read');
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
    if (headerEnd < 0) throw new Error('tracked HarmonyOS blob response is incomplete');
    const header = output.subarray(offset, headerEnd).toString('utf8');
    const match = /^([0-9a-f]{40,64}) blob ([0-9]+)$/.exec(header);
    if (!match || match[1] !== entry.oid) {
      throw new Error('tracked HarmonyOS input must resolve to the captured blob');
    }
    const length = Number(match[2]);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + length;
    if (!Number.isSafeInteger(length) || length < 0 || contentEnd >= output.length
        || output[contentEnd] !== 0x0a) {
      throw new Error('tracked HarmonyOS blob response is malformed');
    }
    inputs.push({ filename, content: output.subarray(contentStart, contentEnd) });
    offset = contentEnd + 1;
  }
  if (offset !== output.length) throw new Error('tracked HarmonyOS blob response has trailing data');
  return inputs;
}

function trackedInputDigest(inputs) {
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

function replaceExactly(source, expected, replacement) {
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error('tracked environment template does not match the expected single declaration');
  }
  return `${source.substring(0, first)}${replacement}${source.substring(first + expected.length)}`;
}

function unsignedBuildProfile() {
  return `{
  "app": {
    "signingConfigs": [],
    "products": [{
      "name": "default",
      "signingConfig": "",
      "compatibleSdkVersion": "6.0.0(20)",
      "runtimeOS": "HarmonyOS"
    }],
    "buildModeSet": [{ "name": "debug" }, { "name": "release" }]
  },
  "modules": [{
    "name": "entry",
    "srcPath": "./entry",
    "targets": [{ "name": "default", "applyToProducts": ["default"] }]
  }]
}
`;
}

function generatedWorkspaceInputs(inputs, origin) {
  const environmentFilename = `${harmonyPrefix}${environmentRelative.split(path.sep).join('/')}`;
  let environmentSeen = false;
  const generated = inputs.map(input => {
    const filename = input.filename.substring(harmonyPrefix.length);
    if (input.filename !== environmentFilename) return { filename, content: input.content };
    environmentSeen = true;
    let environment = input.content.toString('utf8');
    environment = replaceExactly(
      environment,
      "static readonly PROFILE: string = 'develop-blocked';",
      "static readonly PROFILE: string = 'synthetic-approved';"
    );
    environment = replaceExactly(
      environment,
      'static readonly NETWORK_ENABLED: boolean = false;',
      'static readonly NETWORK_ENABLED: boolean = true;'
    );
    environment = replaceExactly(
      environment,
      "static readonly API_ORIGIN: string = 'https://harmony-child.invalid';",
      `static readonly API_ORIGIN: string = '${origin}';`
    );
    return { filename, content: Buffer.from(environment, 'utf8') };
  });
  if (!environmentSeen) throw new Error('tracked HarmonyOS project is missing ApiEnvironment');
  generated.push({
    filename: 'build-profile.json5',
    content: Buffer.from(unsignedBuildProfile(), 'utf8')
  });
  return generated.sort((left, right) => left.filename.localeCompare(right.filename));
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

function verifyGeneratedFiles(staging, verificationInputs) {
  const expectedFiles = verificationInputs.map(input => input.filename).sort();
  if (filesIn(staging).join('\0') !== expectedFiles.join('\0')) {
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
  if (!path.basename(real).startsWith('.tangguan-harmony-stage-')) {
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

function prepareWorkspace({ origin, output, acknowledged }) {
  if (!acknowledged) {
    throw new Error('explicit approved synthetic origin acknowledgement is required');
  }
  const approvedOrigin = validateApprovedOrigin(origin);
  const destination = resolveOutput(output);
  assertCanonicalGitRoot();
  const sourceCommit = gitText(['rev-parse', '--verify', 'HEAD']);
  const sourceImplementationFiles = implementationDigests();
  const sourceEntries = trackedHarmonyEntries();
  const files = sourceEntries.map(entry => entry.filename);
  const inputs = trackedInputs(files, sourceEntries);
  const sourceTreeSha256 = trackedInputDigest(inputs);
  if (sourceTreeSha256 !== auditedHarmonySourceTreeSha256) {
    throw new Error('tracked HarmonyOS source tree differs from the audited synthetic input');
  }
  const generated = generatedWorkspaceInputs(inputs, approvedOrigin);
  const generatedTreeSha256 = trackedInputDigest(generated);
  let staging = '';
  try {
    staging = fs.mkdtempSync(path.join(path.dirname(destination), '.tangguan-harmony-stage-'));
    verifyTemporaryDirectory(staging);
    writeGeneratedInputs(staging, generated);

    const finalCommit = gitText(['rev-parse', '--verify', 'HEAD']);
    const finalEntries = trackedHarmonyEntries();
    const finalFiles = finalEntries.map(entry => entry.filename);
    const finalInputs = trackedInputs(finalFiles, finalEntries);
    const finalImplementationFiles = implementationDigests();
    if (sourceCommit !== finalCommit
        || files.join('\0') !== finalFiles.join('\0')
        || sourceTreeSha256 !== trackedInputDigest(finalInputs)
        || JSON.stringify(sourceImplementationFiles) !== JSON.stringify(finalImplementationFiles)) {
      throw new Error('tracked HarmonyOS source or generator implementation changed during preparation');
    }

    const environmentFilename = environmentRelative.split(path.sep).join('/');
    const manifest = {
      schemaVersion: 2,
      projectType: 'harmonyos',
      profile: 'synthetic-approved',
      origin: approvedOrigin,
      sourceCommit,
      sourceTreeSha256,
      auditedSourceTreeRequired: true,
      auditedSourceTreeSha256: auditedHarmonySourceTreeSha256,
      clientSourceIndexMatchesHead: true,
      clientSourceWorktreeInspected: false,
      clientSourceWorktreeUsed: false,
      sourceSelectedTrackedFileCount: files.length,
      sourceSelectedTrackedFilesSha256: namesDigest(files),
      generatedTreeSha256,
      implementationFiles: sourceImplementationFiles,
      patchedFiles: [environmentFilename, 'build-profile.json5'].map(filename => ({
        path: filename,
        sha256: contentSha256(generated.find(input => input.filename === filename).content)
      })),
      trackedFilesOnly: true,
      privateRootBuildProfileCopied: false,
      unsigned: true,
      temporaryWorkspace: true,
      infrastructureConnectivityVerified: false,
      dnsVerified: false,
      tlsVerified: false,
      adultDeviceSmokeVerified: false,
      huksAssetStoreRuntimeVerified: false,
      devEcoInvoked: false,
      buildPerformed: false,
      signingPerformed: false,
      requiresExternalInfrastructureApproval: true
    };
    const manifestInput = {
      filename: '.synthetic-workspace.json',
      content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    };
    fs.writeFileSync(path.join(staging, manifestInput.filename), manifestInput.content, { flag: 'wx' });
    verifyGeneratedFiles(staging, [...generated, manifestInput]);
    if (fs.existsSync(destination)) throw new Error('output path must not already exist');
    // Atomic publish is the final fallible operation. No path-based recursive
    // rollback runs after a successful rename.
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
    '  node scripts/prepare-harmonyos-synthetic-workspace.js',
    '    --origin https://approved-synthetic.example.com',
    '    --output <new-directory-under-system-temp>',
    '    --acknowledge-approved-synthetic-origin',
    '',
    'The command copies only git-tracked HarmonyOS files, creates an unsigned profile,',
    'and never connects to the supplied origin.'
  ].join('\n');
}

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) process.stdout.write(`${usage()}\n`);
    else {
      prepareWorkspace(options);
      process.stdout.write('Synthetic HarmonyOS workspace prepared without network access.\n');
    }
  } catch (error) {
    process.stderr.write('Synthetic HarmonyOS workspace preparation failed.\n');
    process.exitCode = 1;
  }
}

module.exports = {
  canonicalHttpsOrigin,
  parseTrackedEntries,
  parseArguments,
  prepareWorkspace,
  readRegularFileWithin,
  resolveOutput,
  selectHarmonyFiles,
  trackedInputDigest,
  trackedHarmonyFiles,
  validateApprovedOrigin
};
