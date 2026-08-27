const childProcess = require('node:child_process');
const cluster = require('node:cluster');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const http2 = require('node:http2');
const https = require('node:https');
const Module = require('node:module');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const workerThreads = require('node:worker_threads');

const projectRoot = path.resolve(__dirname, '..', '..');
const realpathSync = fs.realpathSync.native || fs.realpathSync;
const ERROR_CODE = 'SYNTHETIC_PREFLIGHT_OFFLINE_FORBIDDEN';
const ROOT_ENV = 'TANGGUAN_PREFLIGHT_GUARD_ROOT';
const OUTPUT_ENV = 'TANGGUAN_PREFLIGHT_GUARD_OUTPUT';
const OFFLINE_GUARD_MARKER = Symbol.for(
  'tangguan.syntheticPreflightOfflineGuardInstalled.v1'
);
const rootPrefix = 'tangguan-synthetic-api-preflight-verification-';
const stagingPrefix = '.tangguan-api-preflight-stage-';
const evidenceName = '.synthetic-api-preflight.json';
const preflightPath = path.join(projectRoot, 'scripts', 'preflight-synthetic-api.js');
const arrayIsArray = Array.isArray;
const arrayFrom = Array.from;
const arraySlice = Function.call.bind(Array.prototype.slice);
const arraySome = Function.call.bind(Array.prototype.some);
const bufferEquals = Function.call.bind(Buffer.prototype.equals);
const bufferAlloc = Buffer.alloc.bind(Buffer);
const bufferFrom = Buffer.from.bind(Buffer);
const bufferIndexOf = Function.call.bind(Buffer.prototype.indexOf);
const bufferIsBuffer = Buffer.isBuffer;
const bufferSubarray = Function.call.bind(Buffer.prototype.subarray);
const bufferToString = Function.call.bind(Buffer.prototype.toString);
const hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);
const numberFrom = Number;
const numberIsSafeInteger = Number.isSafeInteger;
const objectKeys = Object.keys;
const pathRelative = path.relative.bind(path);
const pathResolve = path.resolve.bind(path);
const pathIsAbsolute = path.isAbsolute.bind(path);
const regexpExec = Function.call.bind(RegExp.prototype.exec);
const regexpTest = Function.call.bind(RegExp.prototype.test);
const reflectApply = Reflect.apply;
const setHas = Function.call.bind(Set.prototype.has);
const stringEndsWith = Function.call.bind(String.prototype.endsWith);
const stringSlice = Function.call.bind(String.prototype.slice);
const stringSplit = Function.call.bind(String.prototype.split);
const stringStartsWith = Function.call.bind(String.prototype.startsWith);
const implementationFiles = Object.freeze([
  'package.json',
  'scripts/bootstrap-synthetic-database.js',
  'scripts/capture-synthetic-candidate-evidence.js',
  'scripts/finalize-synthetic-candidate-evidence.js',
  'scripts/preflight-synthetic-api.js',
  'scripts/prepare-synthetic-data-root.js',
  'scripts/support/synthetic-bootstrap.js',
  'scripts/support/synthetic-candidate-evidence.js',
  'scripts/support/synthetic-data-root-tools.js',
  'scripts/support/synthetic-preflight-offline-guard.js',
  'scripts/verify-synthetic-api-preflight.js',
  'scripts/verify-synthetic-data-root.js',
  'server/config/defaults.js',
  'server/config/deployment-profile.js',
  'server/config/env.js',
  'server/config/guardian-consent.js',
  'server/config/synthetic-runtime-filesystem.js',
  'server/db/connection.js',
  'server/db/migrations.js',
  'server/db/migrations/001_init.sql',
  'server/db/migrations/002_token_revocation.sql',
  'server/db/migrations/003_transaction_soft_delete.sql',
  'server/db/migrations/004_family_rules_history.sql',
  'server/db/migrations/005_transaction_rule_ids.sql',
  'server/db/migrations/006_guardian_consent_enrollment.sql',
  'server/db/migrations/007_device_pairing_sessions.sql',
  'server/db/migrations/008_point_requests_transaction_sources.sql',
  'server/db/migrations/009_data_rights_audit.sql',
  'server/db/migrations/010_synthetic_bootstrap_receipt.sql',
  'server/lib/backup.js',
  'server/lib/password.js',
  'server/lib/token.js',
  'server/lib/wx-auth.js',
  'server/routes/backup.js'
]);
const migrationImplementationFiles = Object.freeze(
  implementationFiles.filter(filename => filename.startsWith('server/db/migrations/'))
);

function forbidden(reason = '') {
  const error = new Error('synthetic preflight offline guard rejected an operation');
  error.code = ERROR_CODE;
  if (reason) error.guardReason = reason;
  return error;
}

function samePath(left, right) {
  return pathRelative(pathResolve(left), pathResolve(right)) === '';
}

function isWithin(base, candidate) {
  const relative = pathRelative(base, candidate);
  return relative === ''
    || (relative !== '..' && !stringStartsWith(relative, `..${path.sep}`)
      && !pathIsAbsolute(relative));
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || arrayIsArray(value)) return false;
  const keys = objectKeys(value);
  if (keys.length !== expected.length) return false;
  for (const key of expected) if (!hasOwn(value, key)) return false;
  return true;
}

function boundaryFromEnvironment() {
  const rootValue = process.env[ROOT_ENV];
  const outputValue = process.env[OUTPUT_ENV];
  delete process.env[ROOT_ENV];
  delete process.env[OUTPUT_ENV];
  if (typeof rootValue !== 'string' || typeof outputValue !== 'string'
      || !path.isAbsolute(rootValue) || !path.isAbsolute(outputValue)
      || (process.platform === 'win32'
        && (rootValue.replaceAll('/', '\\').startsWith('\\\\')
          || outputValue.replaceAll('/', '\\').startsWith('\\\\')))) {
    throw forbidden();
  }
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = path.resolve(rootValue);
  const output = path.resolve(outputValue);
  const metadata = fs.lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || !path.basename(root).startsWith(rootPrefix)
      || !isWithin(temporaryRoot, root)
      || !samePath(output, path.join(root, 'evidence'))
      || fs.existsSync(output)) {
    throw forbidden();
  }
  const realRoot = realpathSync(root);
  const realTemporaryRoot = realpathSync(temporaryRoot);
  if (!isWithin(realTemporaryRoot, realRoot)) throw forbidden();
  return Object.freeze({ root, realRoot, output });
}

function minimumGitEnvironment() {
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

function environmentValue(environment, name) {
  const entry = Object.entries(environment).find(([key]) => key.toUpperCase() === name);
  return entry && entry[1];
}

function resolveGitExecutable(environment, boundary) {
  const searchPath = environmentValue(environment, 'PATH');
  if (typeof searchPath !== 'string' || !searchPath) throw forbidden();
  const realProjectRoot = realpathSync(projectRoot);
  const realTemporaryRoot = realpathSync(os.tmpdir());
  const executableName = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const rawDirectory of searchPath.split(path.delimiter)) {
    const directory = rawDirectory.replace(/^"|"$/g, '');
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, executableName);
    if (!fs.existsSync(candidate)) continue;
    const real = realpathSync(candidate);
    const metadata = fs.statSync(real);
    if (!metadata.isFile() || isWithin(realProjectRoot, real)
        || isWithin(boundary.realRoot, real) || isWithin(realTemporaryRoot, real)) {
      continue;
    }
    return real;
  }
  throw forbidden();
}

function exactEnvironment(actual, expected) {
  if (!actual || typeof actual !== 'object') return false;
  const actualKeys = objectKeys(actual);
  const expectedKeys = objectKeys(expected);
  if (actualKeys.length !== expectedKeys.length) return false;
  for (const key of expectedKeys) {
    if (!hasOwn(actual, key) || actual[key] !== expected[key]) return false;
  }
  return true;
}

function exactArguments(actual, expected) {
  if (!arrayIsArray(actual) || actual.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) return false;
  }
  return true;
}

function validObjectId(value) {
  return typeof value === 'string'
    && (regexpTest(/^[0-9a-f]{40}$/, value) || regexpTest(/^[0-9a-f]{64}$/, value))
    && !regexpTest(/^0+$/, value);
}

function gitCommand(arguments_) {
  const prefix = [
    '--no-pager',
    '--no-optional-locks',
    '--no-replace-objects',
    '-c', 'core.fsmonitor=false',
    '-c', `safe.directory=${realpathSync(projectRoot)}`
  ];
  if (!arrayIsArray(arguments_)
      || !exactArguments(arraySlice(arguments_, 0, prefix.length), prefix)) return null;
  return arraySlice(arguments_, prefix.length);
}

function assertAllowedGitInvocation(file, arguments_, options, expectedEnvironment) {
  const command = gitCommand(arguments_);
  let operation = null;
  if (exactArguments(command, ['rev-parse', '--show-toplevel'])) {
    operation = { kind: 'root' };
  } else if (exactArguments(command, ['rev-parse', '--verify', 'HEAD^{commit}'])) {
    operation = { kind: 'head' };
  } else if (exactArguments(command, [
    'ls-files', '--stage', '-z', '--', ...implementationFiles
  ])) {
    operation = { kind: 'index' };
  } else if (command && command.length === implementationFiles.length + 6
      && exactArguments(arraySlice(command, 0, 4), ['ls-tree', '-r', '-z', '--full-tree'])
      && validObjectId(command[4])
      && command[5] === '--'
      && exactArguments(arraySlice(command, 6), implementationFiles)) {
    operation = { kind: 'tree', commit: command[4] };
  } else if (exactArguments(command, ['cat-file', '--batch'])) {
    operation = { kind: 'batch' };
  }
  if (file !== 'git' || !operation
      || !options || typeof options.cwd !== 'string'
      || !samePath(options.cwd, projectRoot)
      || options.windowsHide !== true || options.maxBuffer !== 16 * 1024 * 1024
      || !exactEnvironment(options.env, expectedEnvironment)) {
    throw forbidden();
  }
  const isBatch = operation.kind === 'batch';
  const expectedOptionKeys = isBatch
    ? ['cwd', 'encoding', 'env', 'input', 'maxBuffer', 'windowsHide']
    : ['cwd', 'encoding', 'env', 'maxBuffer', 'windowsHide'];
  if (!exactKeys(options, expectedOptionKeys)) throw forbidden();
  if (isBatch) {
    if (options.encoding !== null || typeof options.input !== 'string'
        || !regexpTest(/^(?:(?:[0-9a-f]{40}|[0-9a-f]{64})\n)+$/, options.input)
        || stringSplit(stringSlice(options.input, 0, -1), '\n').length
          !== implementationFiles.length) {
      throw forbidden();
    }
  } else if (options.encoding !== 'utf8') {
    throw forbidden();
  }
  return operation;
}

function parseIndexEntries(output) {
  if (typeof output !== 'string' || !stringEndsWith(output, '\0')) throw forbidden();
  const entries = [];
  for (const record of stringSplit(stringSlice(output, 0, -1), '\0')) {
    const match = regexpExec(
      /^(100644|100755) ((?:[0-9a-f]{40}|[0-9a-f]{64})) 0\t(.+)$/,
      record
    );
    if (!match || !validObjectId(match[2])) throw forbidden();
    entries.push({ mode: match[1], oid: match[2], filename: match[3] });
  }
  if (entries.length !== implementationFiles.length
      || arraySome(entries, (entry, index) => entry.filename !== implementationFiles[index])) {
    throw forbidden();
  }
  return entries;
}

function parseTreeEntries(output) {
  if (typeof output !== 'string' || !stringEndsWith(output, '\0')) throw forbidden();
  const entries = [];
  for (const record of stringSplit(stringSlice(output, 0, -1), '\0')) {
    const match = regexpExec(
      /^(100644|100755) blob ((?:[0-9a-f]{40}|[0-9a-f]{64}))\t(.+)$/,
      record
    );
    if (!match || !validObjectId(match[2])) throw forbidden();
    entries.push({ mode: match[1], oid: match[2], filename: match[3] });
  }
  if (entries.length !== implementationFiles.length
      || arraySome(entries, (entry, index) => entry.filename !== implementationFiles[index])) {
    throw forbidden();
  }
  return entries;
}

function entrySignature(entries) {
  let signature = '';
  for (const entry of entries) {
    if (signature) signature += '\0';
    signature += `${entry.mode} ${entry.oid}\t${entry.filename}`;
  }
  return signature;
}

function batchInput(entries) {
  let input = '';
  for (const entry of entries) input += `${entry.oid}\n`;
  return input;
}

function assertBatchOutput(output, entries) {
  if (!bufferIsBuffer(output)) throw forbidden();
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = bufferIndexOf(output, 0x0a, offset);
    if (headerEnd < 0) throw forbidden();
    const match = regexpExec(
      /^((?:[0-9a-f]{40}|[0-9a-f]{64})) blob (0|[1-9][0-9]*)$/,
      bufferToString(bufferSubarray(output, offset, headerEnd), 'utf8')
    );
    const length = match ? numberFrom(match[2]) : -1;
    const start = headerEnd + 1;
    const end = start + length;
    if (!match || !validObjectId(match[1]) || match[1] !== entry.oid
        || !numberIsSafeInteger(length) || length < 0
        || length > output.length - start - 1 || output[end] !== 0x0a) {
      throw forbidden();
    }
    offset = end + 1;
  }
  if (offset !== output.length) throw forbidden();
}

function assertSafeEvidenceDirectory(directory, realRoot) {
  const metadata = fs.lstatSync(directory);
  const real = realpathSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || !isWithin(realRoot, real) || samePath(realRoot, real)) {
    throw forbidden();
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length > 1 || (entries.length === 1 && entries[0].name !== evidenceName)) {
    throw forbidden();
  }
  if (entries.length === 1) {
    const evidence = path.join(directory, evidenceName);
    const evidenceMetadata = fs.lstatSync(evidence);
    if (!evidenceMetadata.isFile() || evidenceMetadata.isSymbolicLink()
        || evidenceMetadata.nlink !== 1
        || !samePath(realpathSync(evidence), path.join(real, evidenceName))) {
      throw forbidden();
    }
  }
}

function assertNoDynamicModuleSource(source) {
  for (const pattern of [
    /\bimport\s*\(/,
    /\beval\s*\(/,
    /\bFunction\s*\(/,
    /\.constructor\b/,
    /\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen|execve|getBuiltinModule|loadEnvFile)\s*\(/
  ]) {
    if (pattern.test(source)) throw forbidden();
  }
}

function assertAuditedSourceShape() {
  const migrationEntries = fs.readdirSync(
    path.join(projectRoot, 'server', 'db', 'migrations'),
    { withFileTypes: true }
  );
  const sqlEntries = migrationEntries.filter(entry => entry.name.endsWith('.sql'));
  const actualMigrations = sqlEntries
    .map(entry => `server/db/migrations/${entry.name}`)
    .sort();
  if (sqlEntries.some(entry => !entry.isFile() || entry.isSymbolicLink())
      || actualMigrations.length !== migrationImplementationFiles.length
      || actualMigrations.some((filename, index) => (
        filename !== migrationImplementationFiles[index]
      ))) {
    throw forbidden('MIGRATION_SET_INVALID');
  }
  for (const filename of [
    preflightPath,
    path.join(projectRoot, 'server', 'config', 'deployment-profile.js')
  ]) {
    const metadata = fs.lstatSync(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
        || !samePath(realpathSync(filename), filename)) {
      throw forbidden();
    }
    assertNoDynamicModuleSource(fs.readFileSync(filename, 'utf8'));
  }
  const evalIndex = process.execArgv.findIndex(argument => argument === '-e' || argument === '--eval');
  if (evalIndex >= 0 && typeof process.execArgv[evalIndex + 1] === 'string') {
    assertNoDynamicModuleSource(process.execArgv[evalIndex + 1]);
  }
}

function safeReadOptions(options) {
  if (options === undefined || options === null) return true;
  if (typeof options === 'string') return options === 'utf8' || options === 'utf-8';
  if (!exactKeys(options, objectKeys(options))) return false;
  if (arraySome(objectKeys(options), key => key !== 'encoding' && key !== 'flag')) return false;
  return (options.flag === undefined || options.flag === 'r')
    && (options.encoding === undefined || options.encoding === null
      || options.encoding === 'utf8' || options.encoding === 'utf-8');
}

function installOfflineGuard() {
  const boundary = boundaryFromEnvironment();
  assertAuditedSourceShape();
  const expectedGitEnvironment = Object.freeze(minimumGitEnvironment());
  const gitExecutable = resolveGitExecutable(expectedGitEnvironment, boundary);
  Object.defineProperty(globalThis, OFFLINE_GUARD_MARKER, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });
  const expectedGitOperations = Object.freeze([
    'root', 'head', 'index', 'tree', 'batch', 'head', 'index', 'tree',
    'root', 'head', 'index', 'tree', 'batch', 'head', 'index', 'tree'
  ]);
  let staging = '';
  let realStaging = '';
  let evidenceWritten = false;
  let published = false;
  let gitStep = 0;
  let gitViolation = false;
  let capturedRoot = '';
  let capturedCommit = '';
  let objectIdLength = 0;
  let implementationSignature = '';
  let pendingIndex = null;
  let expectedBatchEntries = null;
  let capturedBatchOutput = null;

  const replace = (target, key, replacement) => {
    if (typeof target[key] !== 'function') return;
    const original = target[key];
    target[key] = replacement(original);
  };
  const block = (target, key) => replace(target, key, () => function blockedOperation() {
    throw forbidden();
  });
  const evidenceOpenSync = fs.openSync;
  const evidenceReadSync = fs.readSync;
  const evidenceWriteSync = fs.writeSync;
  const evidenceCloseSync = fs.closeSync;
  const evidenceFstatSync = fs.fstatSync;
  const evidenceLstatSync = fs.lstatSync;
  const evidenceStatSync = fs.statSync;

  replace(fs, 'mkdtempSync', original => function guardedMkdtempSync(prefix, options) {
    if (gitStep !== 8 || staging || published || options !== undefined
        || !samePath(path.dirname(prefix), boundary.root)
        || path.basename(prefix) !== stagingPrefix) {
      throw forbidden();
    }
    const created = original.call(this, prefix);
    const metadata = fs.lstatSync(created);
    const real = realpathSync(created);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || !isWithin(boundary.realRoot, real) || samePath(boundary.realRoot, real)) {
      throw forbidden();
    }
    staging = path.resolve(created);
    realStaging = real;
    return created;
  });
  replace(fs, 'readFileSync', () => function guardedReadFileSync(filename, options) {
    const allowedImplementation = typeof filename === 'string'
      && arraySome(implementationFiles, item => samePath(
        filename,
        path.join(projectRoot, ...stringSplit(item, '/'))
      ));
    const allowedEvidence = typeof filename === 'string' && staging
      && samePath(filename, path.join(staging, evidenceName));
    if ((!allowedImplementation && !allowedEvidence) || !safeReadOptions(options)) {
      throw forbidden();
    }
    const pathMetadata = reflectApply(evidenceLstatSync, fs, [filename]);
    if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() || pathMetadata.nlink !== 1
        || !samePath(realpathSync(filename), filename)) {
      throw forbidden();
    }
    let descriptor;
    let content;
    try {
      descriptor = reflectApply(evidenceOpenSync, fs, [filename, 'r']);
      const descriptorMetadata = reflectApply(evidenceFstatSync, fs, [descriptor]);
      const currentPathMetadata = reflectApply(evidenceStatSync, fs, [filename]);
      if (!descriptorMetadata.isFile() || descriptorMetadata.nlink !== 1
          || descriptorMetadata.size < 0 || descriptorMetadata.size > 16 * 1024 * 1024
          || descriptorMetadata.dev !== currentPathMetadata.dev
          || descriptorMetadata.ino !== currentPathMetadata.ino) {
        throw forbidden();
      }
      content = bufferAlloc(descriptorMetadata.size);
      let offset = 0;
      while (offset < content.length) {
        const read = reflectApply(evidenceReadSync, fs, [
          descriptor,
          content,
          offset,
          content.length - offset,
          null
        ]);
        if (!numberIsSafeInteger(read) || read <= 0) throw forbidden();
        offset += read;
      }
      const finalMetadata = reflectApply(evidenceFstatSync, fs, [descriptor]);
      if (finalMetadata.size !== descriptorMetadata.size
          || finalMetadata.mtimeMs !== descriptorMetadata.mtimeMs) {
        throw forbidden();
      }
    } finally {
      if (descriptor !== undefined) reflectApply(evidenceCloseSync, fs, [descriptor]);
    }
    const encoding = typeof options === 'string'
      ? options
      : options && options.encoding;
    return encoding ? bufferToString(content, 'utf8') : content;
  });
  replace(fs, 'writeFileSync', () => function guardedWriteFileSync(filename, data, options) {
    if (gitStep !== 8) throw forbidden(`WRITE_GIT_STEP_${gitStep}`);
    if (!staging) throw forbidden('WRITE_STAGING_MISSING');
    if (evidenceWritten) throw forbidden('WRITE_ALREADY_COMPLETED');
    if (published) throw forbidden('WRITE_ALREADY_PUBLISHED');
    if (!samePath(filename, path.join(staging, evidenceName))) {
      throw forbidden('WRITE_PATH_INVALID');
    }
    if (!exactKeys(options, ['flag']) || options.flag !== 'wx') {
      throw forbidden('WRITE_OPTIONS_INVALID');
    }
    if (!bufferIsBuffer(data)) throw forbidden('WRITE_DATA_INVALID');
    let descriptor;
    try {
      descriptor = reflectApply(evidenceOpenSync, fs, [filename, 'wx', 0o600]);
      let offset = 0;
      while (offset < data.length) {
        const written = reflectApply(evidenceWriteSync, fs, [
          descriptor,
          data,
          offset,
          data.length - offset
        ]);
        if (!numberIsSafeInteger(written) || written <= 0) {
          throw forbidden('WRITE_INCOMPLETE');
        }
        offset += written;
      }
    } finally {
      if (descriptor !== undefined) reflectApply(evidenceCloseSync, fs, [descriptor]);
    }
    evidenceWritten = true;
    return undefined;
  });
  replace(fs, 'renameSync', original => function guardedRenameSync(source, destination) {
    if (gitViolation || gitStep !== expectedGitOperations.length
        || !staging || !evidenceWritten || published
        || !samePath(source, staging) || !samePath(destination, boundary.output)
        || fs.existsSync(boundary.output)) {
      throw forbidden();
    }
    assertSafeEvidenceDirectory(staging, boundary.realRoot);
    const result = original.call(this, source, destination);
    published = true;
    return result;
  });
  replace(fs, 'rmSync', original => function guardedRmSync(target, options) {
    const matchesStaging = typeof target === 'string' && staging
      && (samePath(target, staging)
        || (fs.existsSync(target) && samePath(realpathSync(target), realStaging)));
    if (!matchesStaging || published
        || !exactKeys(options, ['force', 'recursive'])
        || options.force !== true || options.recursive !== true) {
      throw forbidden();
    }
    assertSafeEvidenceDirectory(staging, boundary.realRoot);
    const result = original.call(this, target, options);
    staging = '';
    realStaging = '';
    return result;
  });

  const blockedFsMethods = [
    'appendFile', 'appendFileSync', 'chmod', 'chmodSync', 'chown', 'chownSync',
    'copyFile', 'copyFileSync', 'cp', 'cpSync', 'fchmod', 'fchmodSync', 'fchown',
    'fchownSync', 'ftruncate', 'ftruncateSync', 'futimes', 'futimesSync', 'lchmod',
    'lchmodSync', 'lchown', 'lchownSync', 'link', 'linkSync', 'lutimes',
    'lutimesSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'rename', 'rm', 'rmdir',
    'rmdirSync', 'symlink', 'symlinkSync', 'truncate', 'truncateSync', 'unlink',
    'unlinkSync', 'utimes', 'utimesSync', 'write', 'writeFile', 'writeSync',
    'writev', 'writevSync', 'createReadStream', 'createWriteStream', 'read',
    'readSync', 'readv', 'readvSync', 'openAsBlob', 'close', 'closeSync',
    'fdatasync', 'fdatasyncSync', 'fsync', 'fsyncSync', 'fstat', 'fstatSync'
  ];
  for (const key of blockedFsMethods) block(fs, key);
  block(fs, 'open');
  block(fs, 'openSync');
  block(fs, 'readFile');
  if (fs.promises) {
    for (const key of [
      'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'lchmod', 'lchown',
      'link', 'lutimes', 'mkdir', 'mkdtemp', 'open', 'rename', 'rm', 'rmdir',
      'symlink', 'truncate', 'unlink', 'utimes', 'writeFile', 'readFile'
    ]) block(fs.promises, key);
  }

  if (typeof Module.registerHooks !== 'function') throw forbidden();
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const conditions = context && context.conditions
        ? arrayFrom(context.conditions)
        : [];
      if (arraySome(conditions, condition => condition === 'import')) throw forbidden();
      return nextResolve(specifier, context);
    }
  });
  const deploymentPath = path.join(projectRoot, 'server', 'config', 'deployment-profile.js');
  const evalIndex = process.execArgv.findIndex(
    argument => argument === '-e' || argument === '--eval'
  );
  const allowedModuleFiles = Object.freeze([
    preflightPath,
    deploymentPath,
    ...(evalIndex >= 0 ? [
      path.join(projectRoot, '[eval]'),
      path.join(projectRoot, '[eval]-wrapper')
    ] : [])
  ]);
  const originalModuleLoadFile = Module.prototype.load;
  Object.defineProperty(Module.prototype, 'load', {
    value: function guardedModuleLoadFile(filename) {
      if (typeof filename !== 'string'
          || !arraySome(allowedModuleFiles, allowed => samePath(filename, allowed))) {
        throw forbidden();
      }
      return originalModuleLoadFile.call(this, filename);
    },
    configurable: false,
    enumerable: false,
    writable: false
  });
  const originalModuleCompile = Module.prototype._compile;
  Object.defineProperty(Module.prototype, '_compile', {
    value: function guardedModuleCompile(content, filename, format) {
      if (typeof filename !== 'string'
          || !arraySome(allowedModuleFiles, allowed => samePath(filename, allowed))) {
        throw forbidden();
      }
      return originalModuleCompile.call(this, content, filename, format);
    },
    configurable: false,
    enumerable: false,
    writable: false
  });
  const originalJavaScriptLoader = Module._extensions['.js'];
  Object.defineProperty(Module._extensions, '.js', {
    value(module_, filename) {
      if (typeof filename !== 'string'
          || !arraySome(allowedModuleFiles, allowed => samePath(filename, allowed))) {
        throw forbidden();
      }
      return originalJavaScriptLoader(module_, filename);
    },
    configurable: false,
    enumerable: true,
    writable: false
  });
  for (const extension of ['.json', '.node']) {
    Object.defineProperty(Module._extensions, extension, {
      value() { throw forbidden(); },
      configurable: false,
      enumerable: true,
      writable: false
    });
  }
  Object.freeze(Module._extensions);
  const originalModuleLoad = Module._load;
  const allowedBuiltin = new Set([
    'module', 'node:module', 'node:child_process', 'node:crypto', 'node:fs',
    'node:net', 'node:os', 'node:path'
  ]);
  Object.defineProperty(Module, '_load', {
    value: function guardedModuleLoad(request, parent, isMain) {
    const allowedMain = isMain && typeof request === 'string'
      && samePath(request, preflightPath);
    const allowedDeployment = request === '../server/config/deployment-profile'
      && parent && typeof parent.filename === 'string'
      && samePath(parent.filename, preflightPath);
    if (!setHas(allowedBuiltin, request) && !allowedMain && !allowedDeployment) {
      throw forbidden();
    }
      return originalModuleLoad.call(this, request, parent, isMain);
    },
    configurable: false,
    enumerable: true,
    writable: false
  });
  const originalRunMain = Module.runMain;
  let mainRun = false;
  Object.defineProperty(Module, 'runMain', {
    value(...arguments_) {
      if (mainRun || typeof process.argv[1] !== 'string'
          || !samePath(process.argv[1], preflightPath)) {
        throw forbidden();
      }
      mainRun = true;
      return originalRunMain.apply(this, arguments_);
    },
    configurable: false,
    enumerable: true,
    writable: false
  });
  for (const key of [
    'register', 'registerHooks', 'createRequire', '_preloadModules', '_readPackage',
    'enableCompileCache', 'findPackageJSON', 'findSourceMap', 'flushCompileCache',
    'setSourceMapsSupport', 'syncBuiltinESMExports'
  ]) {
    if (typeof Module[key] !== 'function') continue;
    Object.defineProperty(Module, key, {
      value() { throw forbidden(); },
      configurable: false,
      enumerable: true,
      writable: false
    });
  }
  for (const key of [
    'getBuiltinModule', 'binding', '_linkedBinding', 'dlopen', 'execve', 'loadEnvFile'
  ]) {
    if (typeof process[key] !== 'function') continue;
    Object.defineProperty(process, key, {
      value() { throw forbidden(); },
      configurable: false,
      enumerable: false,
      writable: false
    });
  }
  if (process.report && typeof process.report === 'object') {
    for (const key of ['getReport', 'writeReport']) {
      if (typeof process.report[key] !== 'function') continue;
      Object.defineProperty(process.report, key, {
        value() { throw forbidden(); },
        configurable: false,
        enumerable: true,
        writable: false
      });
    }
  }

  block(net.Socket.prototype, 'connect');
  block(net.Server.prototype, 'listen');
  block(net.Server.prototype, '_listen2');
  block(net.Server.prototype, '_setupWorker');
  for (const key of Object.keys(net)) {
    if (typeof net[key] === 'function'
        && !['BlockList', 'Socket', 'isIP'].includes(key)) block(net, key);
  }
  for (const [target, keys] of [
    [http, ['request', 'get']],
    [https, ['request', 'get']],
    [tls, ['connect']],
    [http2, ['connect']],
    [dgram, ['createSocket']]
  ]) {
    for (const key of keys) block(target, key);
  }
  for (const key of [
    'addMembership', 'addSourceSpecificMembership', 'bind', 'connect', 'send', 'sendto'
  ]) block(dgram.Socket.prototype, key);
  const dnsMethods = [
    'lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny',
    'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs',
    'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'
  ];
  for (const key of dnsMethods) {
    block(dns, key);
    if (dns.promises) block(dns.promises, key);
  }
  for (const resolver of [
    dns.Resolver && dns.Resolver.prototype,
    dns.promises && dns.promises.Resolver && dns.promises.Resolver.prototype
  ].filter(Boolean)) {
    for (const key of dnsMethods) block(resolver, key);
  }
  if (typeof globalThis.fetch === 'function') block(globalThis, 'fetch');
  if (typeof globalThis.WebSocket === 'function') block(globalThis, 'WebSocket');
  for (const key of Object.keys(crypto)) {
    if (typeof crypto[key] === 'function'
        && key !== 'createHash'
        && key !== 'createHmac') block(crypto, key);
  }

  replace(childProcess, 'execFileSync', original => function guardedExecFileSync(
    file, arguments_, options
  ) {
    try {
      if (gitViolation) throw forbidden();
      const operation = assertAllowedGitInvocation(
        file,
        arguments_,
        options,
        expectedGitEnvironment
      );
      if (expectedGitOperations[gitStep] !== operation.kind
          || (operation.kind === 'tree' && operation.commit !== capturedCommit)
          || (operation.kind === 'batch' && (!expectedBatchEntries
            || options.input !== batchInput(expectedBatchEntries)))) {
        throw forbidden();
      }
      let command;
      if (operation.kind === 'root') command = ['rev-parse', '--show-toplevel'];
      else if (operation.kind === 'head') command = ['rev-parse', '--verify', 'HEAD^{commit}'];
      else if (operation.kind === 'index') {
        command = ['ls-files', '--stage', '-z', '--', ...implementationFiles];
      } else if (operation.kind === 'tree') {
        command = [
          'ls-tree', '-r', '-z', '--full-tree', capturedCommit, '--', ...implementationFiles
        ];
      } else command = ['cat-file', '--batch'];
      const safeArguments = [
        '--no-pager',
        '--no-optional-locks',
        '--no-replace-objects',
        '-c', 'core.fsmonitor=false',
        '-c', `safe.directory=${realpathSync(projectRoot)}`,
        ...command
      ];
      const safeOptions = {
        cwd: projectRoot,
        windowsHide: true,
        env: expectedGitEnvironment,
        maxBuffer: 16 * 1024 * 1024,
        encoding: operation.kind === 'batch' ? null : 'utf8',
        ...(operation.kind === 'batch' ? { input: batchInput(expectedBatchEntries) } : {})
      };
      const result = original.call(this, gitExecutable, safeArguments, safeOptions);
      if (operation.kind === 'root') {
        const match = typeof result === 'string'
          ? regexpExec(/^([^\r\n]+)\n$/, result)
          : null;
        const root = match && match[1];
        if (!root || !samePath(realpathSync(root), realpathSync(projectRoot))
            || (capturedRoot && !samePath(root, capturedRoot))) {
          throw forbidden();
        }
        capturedRoot = root;
      } else if (operation.kind === 'head') {
        const match = typeof result === 'string'
          ? regexpExec(/^((?:[0-9a-f]{40}|[0-9a-f]{64}))\n$/, result)
          : null;
        const commit = match && match[1];
        if (!validObjectId(commit) || (capturedCommit && commit !== capturedCommit)) {
          throw forbidden();
        }
        capturedCommit = commit;
        objectIdLength = commit.length;
      } else if (operation.kind === 'index') {
        const index = parseIndexEntries(result);
        if (arraySome(index, entry => entry.oid.length !== objectIdLength)) throw forbidden();
        pendingIndex = index;
      } else if (operation.kind === 'tree') {
        if (!pendingIndex) throw forbidden();
        const tree = parseTreeEntries(result);
        const signature = entrySignature(tree);
        if (arraySome(tree, entry => entry.oid.length !== objectIdLength)
            || entrySignature(pendingIndex) !== signature
            || (implementationSignature && implementationSignature !== signature)) {
          throw forbidden();
        }
        implementationSignature = signature;
        expectedBatchEntries = expectedGitOperations[gitStep + 1] === 'batch' ? tree : null;
        pendingIndex = null;
      } else {
        assertBatchOutput(result, expectedBatchEntries);
        if (capturedBatchOutput && !bufferEquals(capturedBatchOutput, result)) throw forbidden();
        if (!capturedBatchOutput) capturedBatchOutput = bufferFrom(result);
        expectedBatchEntries = null;
      }
      gitStep += 1;
      return result;
    } catch (error) {
      gitViolation = true;
      throw error;
    }
  });
  for (const key of Object.keys(childProcess)) {
    if (typeof childProcess[key] === 'function' && key !== 'execFileSync') block(childProcess, key);
  }
  if (childProcess.ChildProcess) block(childProcess.ChildProcess.prototype, 'spawn');
  block(cluster, 'fork');
  block(workerThreads, 'Worker');

  for (const target of [
    fs.Stats && fs.Stats.prototype,
    fs.Dirent && fs.Dirent.prototype,
    fs.promises,
    fs,
    path,
    childProcess,
    crypto,
    net,
    Module.prototype,
    Module,
    process.report,
    Array.prototype,
    String.prototype,
    RegExp.prototype,
    Set.prototype,
    Buffer.prototype,
    Function.prototype,
    Array,
    Set,
    Function,
    Number,
    JSON,
    Object
  ].filter(Boolean)) Object.freeze(target);
}

installOfflineGuard();

module.exports = { ERROR_CODE };
