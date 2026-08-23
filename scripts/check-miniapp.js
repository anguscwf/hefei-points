const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const miniappRoot = path.join(root, 'hefei-miniapp');
const sourceExtensions = new Set(['.js', '.json', '.wxml', '.wxss']);

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

function runChecks() {
  return [
    ...checkJavaScriptSyntax(),
    ...checkRequestTokenFields(),
    ...checkEmbeddedSecrets(),
    ...checkSensitiveUiCalls(),
    ...checkGuardianApiBoundary()
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
  runChecks
};
