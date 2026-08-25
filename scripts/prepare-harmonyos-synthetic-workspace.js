const fs = require('node:fs');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const realpathSync = fs.realpathSync.native || fs.realpathSync;
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
const temporaryRealRoot = realpathSync(temporaryRoot);
const harmonyPrefix = 'hefei-harmonyos/';
const harmonyWorkingRoot = path.join(projectRoot, 'hefei-harmonyos');
const environmentRelative = path.join(
  'entry', 'src', 'main', 'ets', 'config', 'ApiEnvironment.ets'
);
const allowedTrackedExtensions = new Set([
  '.ets', '.json', '.json5', '.md', '.png', '.ts', '.txt'
]);

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
  if (process.platform === 'win32' && value.replaceAll('/', '\\').startsWith('\\\\')) {
    throw new Error('output must stay inside the local temporary directory');
  }
  if (!path.isAbsolute(value)) throw new Error('output must be an absolute path');
  const output = path.resolve(value);
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

function trackedHarmonyFiles() {
  const output = execFileSync(
    'git', ['ls-files', '--stage', '-z', '--', 'hefei-harmonyos'],
    { cwd: projectRoot, encoding: 'utf8', windowsHide: true }
  );
  const files = parseTrackedEntries(output);
  if (files.length === 0) throw new Error('tracked HarmonyOS project is empty');
  if (files.some(filename => (
    filename.toLowerCase() === 'hefei-harmonyos/build-profile.json5'
  ))) {
    throw new Error('private root build profile must not be tracked or copied');
  }
  for (const filename of files) {
    const basename = path.basename(filename);
    const extension = path.extname(filename).toLowerCase();
    if (!filename.startsWith(harmonyPrefix)
        || filename.includes('..') || path.isAbsolute(filename)
        || (basename !== '.gitignore' && !allowedTrackedExtensions.has(extension))) {
      throw new Error('tracked HarmonyOS input contains a forbidden path or signing artifact');
    }
  }
  return files;
}

function gitText(arguments_) {
  return execFileSync(
    'git', arguments_,
    { cwd: projectRoot, encoding: 'utf8', windowsHide: true }
  ).trim();
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

function trackedInputs(files) {
  return files.map(filename => ({
    filename,
    content: readRegularFileWithin(
      harmonyWorkingRoot,
      filename.substring(harmonyPrefix.length)
    )
  }));
}

function trackedInputDigest(inputs) {
  const digest = crypto.createHash('sha256');
  for (const input of inputs) {
    digest.update(Buffer.from(`${input.filename}\0${input.content.length}\0`, 'utf8'));
    digest.update(input.content);
  }
  return digest.digest('hex');
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

function prepareWorkspace({ origin, output, acknowledged }) {
  if (!acknowledged) {
    throw new Error('explicit approved synthetic origin acknowledgement is required');
  }
  const approvedOrigin = validateApprovedOrigin(origin);
  const destination = resolveOutput(output);
  const sourceCommit = gitText(['rev-parse', '--verify', 'HEAD']);
  const sourceStatus = gitText([
    'status', '--porcelain=v1', '--untracked-files=no', '--', 'hefei-harmonyos'
  ]);
  const files = trackedHarmonyFiles();
  const inputs = trackedInputs(files);
  const sourceTreeSha256 = trackedInputDigest(inputs);
  fs.mkdirSync(destination, { recursive: false });
  verifyCreatedOutput(destination);
  for (const input of inputs) {
    const relative = input.filename.substring(harmonyPrefix.length);
    const target = path.join(destination, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, input.content);
  }

  const finalFiles = trackedHarmonyFiles();
  const finalCommit = gitText(['rev-parse', '--verify', 'HEAD']);
  const finalStatus = gitText([
    'status', '--porcelain=v1', '--untracked-files=no', '--', 'hefei-harmonyos'
  ]);
  const finalTreeSha256 = trackedInputDigest(trackedInputs(finalFiles));
  if (sourceCommit !== finalCommit || sourceStatus !== finalStatus
      || files.join('\0') !== finalFiles.join('\0')
      || sourceTreeSha256 !== finalTreeSha256) {
    throw new Error('tracked HarmonyOS source changed while preparing the workspace');
  }

  const environmentFile = path.join(destination, environmentRelative);
  let environment = fs.readFileSync(environmentFile, 'utf8');
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
    `static readonly API_ORIGIN: string = '${approvedOrigin}';`
  );
  fs.writeFileSync(environmentFile, environment, 'utf8');
  fs.writeFileSync(path.join(destination, 'build-profile.json5'), unsignedBuildProfile(), 'utf8');

  fs.writeFileSync(path.join(destination, '.synthetic-workspace.json'), `${JSON.stringify({
    schemaVersion: 1,
    profile: 'synthetic-approved',
    origin: approvedOrigin,
    sourceCommit,
    sourceTreeSha256,
    sourceTrackedChanges: sourceStatus.length > 0,
    trackedFilesOnly: true,
    unsigned: true,
    temporaryWorkspace: true,
    requiresExternalInfrastructureApproval: true
  }, null, 2)}\n`, 'utf8');
  return destination;
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
  trackedInputDigest,
  trackedHarmonyFiles,
  validateApprovedOrigin
};
