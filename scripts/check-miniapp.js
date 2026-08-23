const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const miniappRoot = path.join(root, 'hefei-miniapp');
const sourceExtensions = new Set(['.js', '.json', '.wxml', '.wxss']);
const productionApiBase = 'https://hefeijifen.cn';
const projectConfigFile = path.join(miniappRoot, 'project.config.json');
const runtimeEnvironmentFile = path.join(miniappRoot, 'utils', 'runtime-environment.js');
const legalDocumentMarkup = path.join(miniappRoot, 'pages', 'legal-document', 'legal-document.wxml');
const legalDocumentSource = path.join(miniappRoot, 'pages', 'legal-document', 'legal-document.js');

function filesIn(directory, predicate) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesIn(filename, predicate));
    else if (entry.isFile() && predicate(filename)) files.push(filename);
  }
  return files.sort();
}

function relative(filename) {
  return path.relative(root, filename).split(path.sep).join('/');
}

function miniappJavaScriptFiles() {
  return filesIn(miniappRoot, filename => path.extname(filename).toLowerCase() === '.js');
}

function miniappSourceFiles() {
  return filesIn(miniappRoot, filename => sourceExtensions.has(path.extname(filename).toLowerCase()));
}

function findMatching(source, openIndex, open, close) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function callExpressions(source, pattern) {
  const calls = [];
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(source))) {
    const openIndex = source.indexOf('(', match.index);
    const closeIndex = findMatching(source, openIndex, '(', ')');
    if (closeIndex < 0) break;
    calls.push({ start: match.index, end: closeIndex, text: source.slice(match.index, closeIndex + 1) });
    pattern.lastIndex = closeIndex + 1;
  }
  return calls;
}

function variableCarriesToken(source, identifier, beforeIndex) {
  const declaration = new RegExp(`\\b(?:var|let|const)\\s+${identifier}\\s*=\\s*\\{`, 'g');
  let match;
  let latest;
  while ((match = declaration.exec(source)) && match.index < beforeIndex) latest = match;
  if (!latest) return false;
  const openIndex = source.indexOf('{', latest.index);
  const closeIndex = findMatching(source, openIndex, '{', '}');
  if (closeIndex < 0 || closeIndex > beforeIndex) return false;
  const objectSource = source.slice(openIndex, closeIndex + 1);
  if (/\btoken\b\s*['"]?\s*:/i.test(objectSource)) return true;
  return new RegExp(`\\b${identifier}\\s*(?:\\.\\s*token|\\[\\s*['\"]token['\"]\\s*\\])\\s*=`, 'i')
    .test(source.slice(closeIndex + 1, beforeIndex));
}

function checkJavaScriptSyntax(files = miniappJavaScriptFiles()) {
  const errors = [];
  for (const filename of files) {
    const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' });
    if (result.status !== 0) {
      errors.push(`${relative(filename)}: JavaScript syntax check failed\n${result.stderr || result.stdout}`);
    }
  }
  return errors;
}

function checkRequestTokenFields(files = miniappJavaScriptFiles()) {
  const errors = [];
  const requestPattern = /\b(?:fetchAPI|request)\s*\(/g;
  for (const filename of files) {
    const source = fs.readFileSync(filename, 'utf8');
    for (const call of callExpressions(source, requestPattern)) {
      if (/\btoken\b\s*['"]?\s*:/i.test(call.text)) {
        errors.push(`${relative(filename)}: request payload contains a token field`);
        continue;
      }
      const identifiers = new Set();
      for (const pattern of [
        /JSON\.stringify\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g,
        /\b(?:body|data)\s*:\s*([A-Za-z_$][\w$]*)\b/g
      ]) {
        let match;
        while ((match = pattern.exec(call.text))) identifiers.add(match[1]);
      }
      if ([...identifiers].some(identifier => variableCarriesToken(source, identifier, call.start))) {
        errors.push(`${relative(filename)}: request payload variable contains a token field`);
      }
    }
  }
  return errors;
}

function checkEmbeddedSecrets(files = miniappSourceFiles()) {
  const errors = [];
  const patterns = [
    { name: 'private key or certificate PEM', value: /-----BEGIN (?:[A-Z]+ )?(?:PRIVATE KEY|CERTIFICATE)-----/ },
    { name: 'AppSecret assignment', value: /\b(?:app_?secret|wechat_?secret)\b\s*[:=]\s*['"`][^'"`\r\n]{8,}/i },
    { name: 'API secret assignment', value: /\b(?:api_?key|secret_?key|private_?key)\b\s*[:=]\s*['"`][A-Za-z0-9+/_=.:-]{16,}/i },
    { name: 'certificate or key file reference', value: /['"`][^'"`\r\n]+\.(?:pem|p12|pfx|key|cer|crt)['"`]/i },
    { name: 'common production API key', value: /\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/ }
  ];
  for (const filename of files) {
    const source = fs.readFileSync(filename, 'utf8');
    for (const pattern of patterns) {
      if (pattern.value.test(source)) errors.push(`${relative(filename)}: contains ${pattern.name}`);
    }
  }
  return errors;
}

function checkSensitiveUiCalls(files = miniappJavaScriptFiles()) {
  const errors = [];
  const callPattern = /\b[A-Za-z_$][\w$]*\.(navigateTo|redirectTo|reLaunch|switchTab|showToast|showToastMsg|setStorage|setStorageSync)\s*\(/g;
  const visibleSensitive = /\b(?:token|password|pwd|reauth(?:Assertion)?|assertion|bindingTicket|pairingCode|shortCode|accessToken|refreshToken|publicKey|challenge|proof|appSecret|privateKey)\b/i;
  const storedSensitive = /\b(?:password|pwd|reauth(?:Assertion)?|assertion|bindingTicket|pairingCode|shortCode|accessToken|refreshToken|publicKey|challenge|proof|dataExport|appSecret|privateKey)\b/i;
  for (const filename of files) {
    const source = fs.readFileSync(filename, 'utf8');
    for (const call of callExpressions(source, callPattern)) {
      const storageCall = /\.setStorage(?:Sync)?\s*\(/.test(call.text);
      const forbidden = storageCall ? storedSensitive : visibleSensitive;
      if (forbidden.test(call.text)) {
        errors.push(`${relative(filename)}: sensitive value appears in ${storageCall ? 'storage' : 'navigation/toast'} source`);
      }
    }
  }
  return errors;
}

function checkGuardianApiBoundary() {
  const filename = path.join(miniappRoot, 'utils', 'guardian-api.js');
  if (!fs.existsSync(filename)) return [];
  const source = fs.readFileSync(filename, 'utf8');
  const forbidden = [
    'claim-by-code',
    'claim/complete',
    'session-challenges',
    'device-sessions/refresh'
  ];
  return forbidden
    .filter(value => source.includes(value))
    .map(value => `${relative(filename)}: guardian API exposes child credential route ${value}`);
}

function checkProjectConfiguration(filename = projectConfigFile) {
  const errors = [];
  let config;
  try {
    config = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    return [`${relative(filename)}: tracked project configuration is missing or invalid JSON`];
  }
  if (!config || config.compileType !== 'miniprogram') {
    errors.push(`${relative(filename)}: compileType must be miniprogram`);
  }
  if (!config.setting || config.setting.urlCheck !== true) {
    errors.push(`${relative(filename)}: tracked urlCheck must be true`);
  }
  return errors;
}

function loadRuntimeEnvironment() {
  delete require.cache[require.resolve(runtimeEnvironmentFile)];
  return require(runtimeEnvironmentFile);
}

function checkRuntimeEnvironmentPolicy(environment = loadRuntimeEnvironment()) {
  const errors = [];
  if (!environment || typeof environment.resolve !== 'function'
      || typeof environment.isProductionOrigin !== 'function') {
    return [`${relative(runtimeEnvironmentFile)}: runtime environment contract is incomplete`];
  }

  for (const envVersion of ['develop', 'trial']) {
    const profile = environment.resolve(envVersion);
    if (!profile || profile.envVersion !== envVersion) {
      errors.push(`${relative(runtimeEnvironmentFile)}: ${envVersion} profile is missing`);
      continue;
    }
    if (environment.isProductionOrigin(profile.apiBase) || profile.apiBase === productionApiBase) {
      errors.push(`${relative(runtimeEnvironmentFile)}: ${envVersion} must reject the production API origin`);
    }
    if (profile.production !== false || profile.environmentReady !== false
        || profile.guardianPreviewEnabled !== false) {
      errors.push(`${relative(runtimeEnvironmentFile)}: ${envVersion} must remain fail closed until an approved synthetic API exists`);
    }
  }

  const unknown = environment.resolve('unknown');
  if (!unknown || unknown.envVersion !== 'unknown'
      || unknown.production !== false
      || unknown.environmentReady !== false
      || unknown.guardianPreviewEnabled !== false
      || environment.isProductionOrigin(unknown.apiBase)
      || unknown.apiBase === productionApiBase) {
    errors.push(`${relative(runtimeEnvironmentFile)}: unknown environments must fail closed away from production`);
  }

  const release = environment.resolve('release');
  if (!release || release.envVersion !== 'release'
      || release.apiBase !== productionApiBase
      || release.production !== true
      || release.environmentReady !== true
      || release.guardianPreviewEnabled !== false
      || !environment.isProductionOrigin(release.apiBase)) {
    errors.push(`${relative(runtimeEnvironmentFile)}: release must use only the production API origin`);
  }
  for (const filename of miniappSourceFiles()) {
    if (path.resolve(filename) === path.resolve(runtimeEnvironmentFile)) continue;
    if (fs.readFileSync(filename, 'utf8').includes(productionApiBase)) {
      errors.push(`${relative(filename)}: production API origin must be declared only in runtime-environment.js`);
    }
  }
  const policySource = fs.readFileSync(runtimeEnvironmentFile, 'utf8');
  if (/\b(?:getStorageSync|getExtConfigSync|getLaunchOptionsSync|getEnterOptionsSync)\s*\(/.test(policySource)) {
    errors.push(`${relative(runtimeEnvironmentFile)}: runtime environment policy must not read client overrides`);
  }
  return errors;
}

function checkWebViewBoundary(files = filesIn(
  miniappRoot,
  filename => path.extname(filename).toLowerCase() === '.wxml'
)) {
  const errors = [];
  const occurrences = [];
  for (const filename of files) {
    const source = fs.readFileSync(filename, 'utf8');
    for (const match of source.matchAll(/<web-view\b[^>]*>/gi)) {
      occurrences.push({ filename, tag: match[0] });
    }
  }
  if (occurrences.length !== 1 || path.resolve(occurrences[0] && occurrences[0].filename || '') !== path.resolve(legalDocumentMarkup)) {
    errors.push('hefei-miniapp: web-view is allowed only once in pages/legal-document/legal-document.wxml');
    return errors;
  }

  const binding = occurrences[0].tag.match(/\bbinderror\s*=\s*["']([A-Za-z_$][\w$]*)["']/i);
  if (!binding) {
    errors.push(`${relative(legalDocumentMarkup)}: web-view must bind an error handler`);
    return errors;
  }
  const pageSource = fs.readFileSync(legalDocumentSource, 'utf8');
  const handler = new RegExp(`\\b${binding[1]}\\s*:\\s*function\\b`);
  if (!handler.test(pageSource)) {
    errors.push(`${relative(legalDocumentSource)}: web-view error handler ${binding[1]} is not implemented`);
  }
  return errors;
}

function runChecks() {
  return [
    ...checkJavaScriptSyntax(),
    ...checkRequestTokenFields(),
    ...checkEmbeddedSecrets(),
    ...checkSensitiveUiCalls(),
    ...checkGuardianApiBoundary(),
    ...checkProjectConfiguration(),
    ...checkRuntimeEnvironmentPolicy(),
    ...checkWebViewBoundary()
  ];
}

if (require.main === module) {
  const errors = runChecks();
  if (errors.length) {
    errors.forEach(error => process.stderr.write(`${error}\n`));
    process.exitCode = 1;
  } else {
    process.stdout.write('miniapp security checks passed\n');
  }
}

module.exports = {
  miniappJavaScriptFiles,
  miniappSourceFiles,
  checkJavaScriptSyntax,
  checkRequestTokenFields,
  checkEmbeddedSecrets,
  checkSensitiveUiCalls,
  checkGuardianApiBoundary,
  checkProjectConfiguration,
  checkRuntimeEnvironmentPolicy,
  checkWebViewBoundary,
  runChecks
};
