const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const defaultHarmonyRoot = path.join(projectRoot, 'hefei-harmonyos');
const mainSourceRelative = path.join('entry', 'src', 'main');
const moduleRelative = path.join(mainSourceRelative, 'module.json5');
const backupConfigRelative = path.join(
  mainSourceRelative,
  'resources',
  'base',
  'profile',
  'backup_config.json'
);
const mainPagesRelative = path.join(
  mainSourceRelative,
  'resources',
  'base',
  'profile',
  'main_pages.json'
);
const privacyShellRelative = path.join(
  mainSourceRelative,
  'ets',
  'privacy',
  'PrivacySafetyShell.ets'
);
const indexPageRelative = path.join(
  mainSourceRelative,
  'ets',
  'pages',
  'Index.ets'
);
const childSessionCoordinatorRelative = path.join(
  mainSourceRelative,
  'ets',
  'session',
  'ChildSessionCoordinator.ets'
);
const textExtensions = new Set(['.ets', '.ts', '.js', '.json', '.json5']);
const productionOriginPattern = /(?:https?:\/\/)?(?:www\.)?hefeijifen\.cn/i;
const healthRoutePattern = /(?:^|["'`\s])\/(?:api\/)?health(?:\/|[?"'`\s]|$)/i;
const identitySelectorPattern = /(?:["']?(?:familyId|childId|adultId|guardianId|userId|role|deviceId|deviceBindingId|sessionId)["']?\s*:)/i;
const privacySideEffectPattern = /@kit\.|@ohos\.|\b(?:fetch|request|Web|WebView|Hyperlink|router|getRouter|openUrl|preferences|PersistentStorage|AppStorage|LocalStorage|Environment|globalThis|asset|huks|coordinator|api|vault|identity)\b/i;
const privacyDynamicDataPattern = /\b(?:childName|familyId|childId|adultId|guardianId|userId|role|deviceId|devicePublicId|deviceBindingId|bindingId|sessionId|accessToken|refreshToken|publicKey|shortCode|balance|transactions|rewardRules|pointRequests|kid|subject|principal|sessionStore)\b/i;

const allowedApiPaths = new Set([
  '/api/v2/device-pairings/claim-by-code',
  '/api/v2/device-pairings/claim/complete',
  '/api/v2/device-sessions/refresh',
  '/api/v2/me/summary',
  '/api/v2/me/transactions',
  '/api/v2/me/reward-rules',
  '/api/v2/me/point-requests',
  '/api/v2/me/point-request-operations/resubmit/reconcile',
  '/api/v2/me/point-request-operations/cancel/reconcile',
  '/api/v2/point-requests'
]);

function filesIn(directory, predicate) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesIn(filename, predicate));
    else if (entry.isFile() && predicate(filename)) files.push(filename);
  }
  return files.sort();
}

function relative(harmonyRoot, filename) {
  return path.relative(harmonyRoot, filename).split(path.sep).join('/');
}

function readFile(filename, harmonyRoot, errors) {
  try {
    return fs.readFileSync(filename, 'utf8');
  } catch (error) {
    errors.push(`${relative(harmonyRoot, filename)}: file is missing or unreadable`);
    return '';
  }
}

function sourceFiles(harmonyRoot) {
  const mainRoot = path.join(harmonyRoot, mainSourceRelative);
  const files = filesIn(
    mainRoot,
    filename => textExtensions.has(path.extname(filename).toLowerCase())
  );
  const appConfig = path.join(harmonyRoot, 'AppScope', 'app.json5');
  if (fs.existsSync(appConfig) && fs.statSync(appConfig).isFile()) files.push(appConfig);
  return files.sort();
}

function codeWithoutComments(source) {
  let result = '';
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        result += '\n';
      } else result += ' ';
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        result += '  ';
        blockComment = false;
        index += 1;
      } else result += char === '\n' ? '\n' : ' ';
      continue;
    }
    if (quote) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      result += '  ';
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      result += '  ';
      blockComment = true;
      index += 1;
      continue;
    }
    result += char;
    if (char === '"' || char === "'" || char === '`') quote = char;
  }
  return result;
}

function codeStructureMask(source) {
  const withoutComments = codeWithoutComments(source);
  let result = '';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const char = withoutComments[index];
    if (quote) {
      result += char === '\n' ? '\n' : ' ';
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      result += ' ';
      continue;
    }
    result += char;
  }
  return result;
}

function stringLiterals(source) {
  const literals = [];
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
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
    if (char !== '"' && char !== "'" && char !== '`') continue;
    const quote = char;
    let body = '';
    let escaped = false;
    for (index += 1; index < source.length; index += 1) {
      const value = source[index];
      if (escaped) {
        body += `\\${value}`;
        escaped = false;
      } else if (value === '\\') {
        escaped = true;
      } else if (value === quote) {
        break;
      } else {
        body += value;
      }
    }
    literals.push({ body, quote });
  }
  return literals;
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
    if (char === '"' || char === "'" || char === '`') {
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

function braceDepthAt(source, endIndex) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < endIndex; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
  }
  return depth;
}

function namedStructBlock(source, name) {
  const structure = codeStructureMask(source);
  const pattern = new RegExp(`(?:^|\\n)\\s*struct\\s+${name}\\s*\\{`, 'g');
  const blocks = [];
  let match;
  while ((match = pattern.exec(structure))) {
    const open = structure.indexOf('{', match.index);
    const close = findMatching(structure, open, '{', '}');
    if (open >= 0 && close > open) blocks.push(source.slice(open + 1, close));
  }
  return blocks.length === 1 ? blocks[0] : '';
}

function topLevelMethodDetails(structSource, name, requirePrivate) {
  if (!structSource) return null;
  const structure = codeStructureMask(structSource);
  const visibility = requirePrivate ? 'private\\s+' : '';
  const pattern = new RegExp(
    `(?:^|\\n)\\s*${visibility}${name}\\s*\\([^)]*\\)[^\\n{]*\\{`,
    'g'
  );
  const methods = [];
  let match;
  while ((match = pattern.exec(structure))) {
    if (braceDepthAt(structure, match.index) !== 0) continue;
    const open = structure.indexOf('{', match.index);
    const close = findMatching(structure, open, '{', '}');
    if (open >= 0 && close > open) {
      methods.push({
        body: structSource.slice(open + 1, close),
        signature: structSource.slice(match.index, open).trim()
      });
    }
  }
  return methods.length === 1 ? methods[0] : null;
}

function topLevelMethodBlock(structSource, name, requirePrivate) {
  const method = topLevelMethodDetails(structSource, name, requirePrivate);
  return method ? method.body : '';
}

function hasUnexpectedBareCall(source, allowedNames) {
  const pattern = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = pattern.exec(source))) {
    if (!allowedNames.has(match[1])) return true;
  }
  return false;
}

function hasUnexpectedMemberCallRoot(source, allowedRoots) {
  const pattern = /(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*\.\s*[A-Za-z_$][\w$]*\s*\(/g;
  let match;
  while ((match = pattern.exec(source))) {
    if (!allowedRoots.has(match[1])) return true;
  }
  return false;
}

function thisMemberNames(source) {
  return [...source.matchAll(
    /\bthis\s*(?:\?\.\s*|\.\s*)([A-Za-z_$][\w$]*)/g
  )].map(match => match[1]);
}

function hasUnsafeThisSyntax(source) {
  return /\bthis\s*(?:!|\?\.\s*\[|\[|\?\.)/.test(source);
}

function hasUnexpectedFreeIdentifier(source, allowedNames) {
  const structure = codeStructureMask(source);
  const pattern = /\b[A-Za-z_$][\w$]*\b/g;
  let match;
  while ((match = pattern.exec(structure))) {
    let previous = match.index - 1;
    while (previous >= 0 && /\s/.test(structure[previous])) previous -= 1;
    if (previous >= 0 && structure[previous] === '.') continue;
    if (!allowedNames.has(match[0])) return true;
  }
  return false;
}

function callExpressions(source, pattern) {
  const calls = [];
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(source))) {
    const openIndex = source.indexOf('(', match.index);
    const closeIndex = findMatching(source, openIndex, '(', ')');
    if (closeIndex < 0) break;
    calls.push({
      start: match.index,
      end: closeIndex,
      text: source.slice(match.index, closeIndex + 1),
      argumentsText: source.slice(openIndex + 1, closeIndex)
    });
    pattern.lastIndex = closeIndex + 1;
  }
  return calls;
}

function splitTopLevelArguments(source) {
  const values = [];
  let start = 0;
  let quote = '';
  let escaped = false;
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '(') round += 1;
    else if (char === ')') round -= 1;
    else if (char === '[') square += 1;
    else if (char === ']') square -= 1;
    else if (char === '{') curly += 1;
    else if (char === '}') curly -= 1;
    else if (char === ',' && round === 0 && square === 0 && curly === 0) {
      values.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (source.slice(start).trim() || values.length) values.push(source.slice(start).trim());
  return values;
}

function isStaticLogValue(value) {
  const source = value.trim();
  if (!source) return true;
  if (/^(?:true|false|null|undefined|NaN|Infinity|-?\d+(?:\.\d+)?)$/.test(source)) return true;
  if (/^"(?:\\.|[^"\\])*"$/.test(source)) return true;
  if (/^'(?:\\.|[^'\\])*'$/.test(source)) return true;
  return /^`(?:\\.|[^`\\])*`$/.test(source) && !source.includes('${');
}

function checkBackupPolicy(harmonyRoot) {
  const errors = [];
  const backupFilename = path.join(harmonyRoot, backupConfigRelative);
  const moduleFilename = path.join(harmonyRoot, moduleRelative);
  const backupSource = readFile(backupFilename, harmonyRoot, errors);
  const moduleSource = readFile(moduleFilename, harmonyRoot, errors);
  if (backupSource) {
    try {
      const config = JSON.parse(backupSource.replace(/^\uFEFF/, ''));
      if (!config || config.allowToBackupRestore !== false) {
        errors.push(`${relative(harmonyRoot, backupFilename)}: allowToBackupRestore must be false`);
      }
    } catch (error) {
      errors.push(`${relative(harmonyRoot, backupFilename)}: backup policy must be valid JSON`);
    }
  }
  if (/\bEntryBackupAbility\b|ohos\.extension\.backup|["']backup["']\s*,?\s*(?:\/\/[^\n]*)?$/im.test(moduleSource)
      || /["']type["']?\s*:\s*["']backup["']/i.test(moduleSource)) {
    errors.push(`${relative(harmonyRoot, moduleFilename)}: backup extension ability must be removed`);
  }
  return errors;
}

function checkPermissions(harmonyRoot) {
  const errors = [];
  const filename = path.join(harmonyRoot, moduleRelative);
  const source = readFile(filename, harmonyRoot, errors);
  if (!source) return errors;
  const permissions = [...source.matchAll(/ohos\.permission\.[A-Z0-9_.]+/g)].map(match => match[0]);
  const unique = [...new Set(permissions)];
  if (unique.length !== 1 || unique[0] !== 'ohos.permission.INTERNET') {
    errors.push(`${relative(harmonyRoot, filename)}: requested permissions must be exactly ohos.permission.INTERNET`);
  }
  return errors;
}

function checkProductionAndDiagnosticRoutes(harmonyRoot, files) {
  const errors = [];
  for (const filename of files) {
    const source = fs.readFileSync(filename, 'utf8');
    if (productionOriginPattern.test(source)) {
      errors.push(`${relative(harmonyRoot, filename)}: production origin is forbidden in main source`);
    }
    if (healthRoutePattern.test(source)) {
      errors.push(`${relative(harmonyRoot, filename)}: diagnostic health route is forbidden in main source`);
    }
  }
  return errors;
}

function checkForbiddenStorageAndDeviceApis(harmonyRoot, files) {
  const errors = [];
  const patterns = [
    { label: 'Preferences', value: /(?:@ohos\.data\.preferences|\bpreferences\b)/i },
    { label: 'PersistentStorage', value: /\bPersistentStorage\b/ },
    { label: 'pasteboard', value: /(?:@ohos\.pasteboard|\bpasteboard\b)/i },
    { label: 'deviceInfo', value: /(?:@ohos\.deviceInfo|\bdeviceInfo\b)/i },
    { label: 'Math.random', value: /\bMath\s*\.\s*random\s*\(/ },
    {
      label: 'file-backed credential storage',
      value: /(?:@ohos\.file\.fs|@kit\.CoreFileKit|\bfileIo\b|\bfilesDir\b|\bgetFilesDir\b|\bfs\s*\.\s*(?:open|write|createStream|copy|move|rename)\s*\()/i
    },
    {
      label: 'credential file reference',
      value: /["'][^"'\r\n]*(?:access|refresh|session|claim|token|credential)[^"'\r\n]*\.(?:json|txt|dat|db)["']/i
    }
  ];
  for (const filename of files.filter(value => /\.(?:ets|ts|js)$/i.test(value))) {
    const source = codeWithoutComments(fs.readFileSync(filename, 'utf8'));
    for (const pattern of patterns) {
      if (pattern.value.test(source)) {
        errors.push(`${relative(harmonyRoot, filename)}: contains forbidden ${pattern.label}`);
      }
    }
  }
  return errors;
}

function checkDynamicLogging(harmonyRoot, files) {
  const errors = [];
  const logPattern = /\b(?:console|hilog)\s*\.\s*(?:debug|info|warn|error|fatal|log)\s*\(/g;
  for (const filename of files.filter(value => /\.(?:ets|ts|js)$/i.test(value))) {
    const source = fs.readFileSync(filename, 'utf8');
    for (const call of callExpressions(source, logPattern)) {
      const args = splitTopLevelArguments(call.argumentsText);
      const isHilog = /^\s*hilog\b/.test(call.text);
      const payload = isHilog ? args.slice(2) : args;
      if (payload.some(value => !isStaticLogValue(value))) {
        errors.push(`${relative(harmonyRoot, filename)}: console/hilog must not log dynamic data`);
      }
    }
  }
  return errors;
}

function checkEmbeddedCredentials(harmonyRoot, files) {
  const errors = [];
  const patterns = [
    { label: 'private key or certificate PEM', value: /-----BEGIN (?:[A-Z]+ )?(?:PRIVATE KEY|CERTIFICATE)-----/ },
    { label: 'AppSecret assignment', value: /\b(?:app_?secret|huawei_?secret)\b\s*[:=]\s*["'`][^"'`\r\n]{8,}/i },
    { label: 'device bearer credential', value: /\btg_(?:claim|access|refresh)\.[A-Za-z0-9_-]{20,}\b/ }
  ];
  for (const filename of files) {
    const source = fs.readFileSync(filename, 'utf8');
    for (const pattern of patterns) {
      if (pattern.value.test(source)) {
        errors.push(`${relative(harmonyRoot, filename)}: contains embedded ${pattern.label}`);
      }
    }
  }
  return errors;
}

function checkSecurityPrimitives(harmonyRoot, files) {
  const sources = files
    .filter(value => /\.(?:ets|ts)$/i.test(value))
    .map(filename => codeWithoutComments(fs.readFileSync(filename, 'utf8')))
    .join('\n');
  const errors = [];
  if (!/@kit\.UniversalKeystoreKit|@ohos\.security\.huks/.test(sources) || !/\bhuks\s*\./.test(sources)) {
    errors.push('entry/src/main: HUKS-backed device key usage is required');
  }
  if (!/HUKS_TAG_AUTH_STORAGE_LEVEL/.test(sources)
      || !/HUKS_AUTH_STORAGE_LEVEL_ECE/.test(sources)) {
    errors.push('entry/src/main: HUKS device key must use explicit unlocked-only ECE storage');
  }
  if (!/@kit\.AssetStoreKit|@ohos\.security\.asset/.test(sources) || !/\basset\s*\./.test(sources)) {
    errors.push('entry/src/main: AssetStore-backed credential storage is required');
  }
  for (const requirement of [
    ['DEVICE_UNLOCKED', /Accessibility\.DEVICE_UNLOCKED/],
    ['SYNC_TYPE=NEVER', /SyncType\.NEVER/],
    ['REQUIRE_PASSWORD_SET=true', /Tag\.REQUIRE_PASSWORD_SET\s*,\s*true/],
    ['IS_PERSISTENT=false', /Tag\.IS_PERSISTENT\s*,\s*false/]
  ]) {
    if (!requirement[1].test(sources)) {
      errors.push(`entry/src/main: AssetStore session must set ${requirement[0]}`);
    }
  }
  const writerRequirements = [
    ['DEVICE_UNLOCKED', /asset\.Tag\.ACCESSIBILITY\s*,\s*asset\.Accessibility\.DEVICE_UNLOCKED/],
    ['SYNC_TYPE=NEVER', /asset\.Tag\.SYNC_TYPE\s*,\s*asset\.SyncType\.NEVER/],
    ['REQUIRE_PASSWORD_SET=true', /asset\.Tag\.REQUIRE_PASSWORD_SET\s*,\s*true/],
    ['IS_PERSISTENT=false', /asset\.Tag\.IS_PERSISTENT\s*,\s*false/]
  ];
  for (const filename of files.filter(value => /\.(?:ets|ts)$/i.test(value))) {
    const source = codeWithoutComments(fs.readFileSync(filename, 'utf8'));
    for (const call of callExpressions(source, /\basset\s*\.\s*add\s*\(/g)) {
      const writer = splitTopLevelArguments(call.argumentsText)[0] || '';
      let writerBlock = '';
      if (/^[A-Za-z_$][\w$]*$/.test(writer)) {
        const declaration = new RegExp(
          `\\b(?:const|let|var)\\s+${writer}(?:\\s*:[^=;]+)?\\s*=\\s*new\\s+Map\\s*\\(`,
          'g'
        );
        let match;
        let latest = null;
        while ((match = declaration.exec(source)) && match.index < call.start) latest = match;
        if (latest) writerBlock = source.slice(latest.index, call.start);
      }
      for (const requirement of writerRequirements) {
        const scoped = new RegExp(
          `\\b${writer}\\s*\\.\\s*set\\s*\\(\\s*${requirement[1].source}`
        );
        if (!writerBlock || !scoped.test(writerBlock)) {
          errors.push(`${relative(harmonyRoot, filename)}: AssetStore writer must set ${requirement[0]}`);
        }
      }
    }
  }
  return errors;
}

function checkEnvironmentPolicy(harmonyRoot, files) {
  const errors = [];
  const sources = files
    .filter(value => /\.(?:ets|ts)$/i.test(value))
    .map(filename => codeWithoutComments(fs.readFileSync(filename, 'utf8')))
    .join('\n');
  const declarations = [...sources.matchAll(
    /\bNETWORK_ENABLED\b\s*(?::\s*(?:boolean|Boolean)\s*)?(?:=|:)\s*(true|false)\b/g
  )].map(match => match[1]);
  if (!declarations.includes('false')) {
    errors.push('entry/src/main: NETWORK_ENABLED must default to false');
  }
  if (declarations.includes('true')) {
    errors.push('entry/src/main: NETWORK_ENABLED must not be enabled in tracked source');
  }
  const environmentFilename = path.join(
    harmonyRoot,
    'entry', 'src', 'main', 'ets', 'config', 'ApiEnvironment.ets'
  );
  if (!files.includes(environmentFilename)) {
    errors.push('entry/src/main: ApiEnvironment.ets is required');
    return errors;
  }

  const environment = codeWithoutComments(fs.readFileSync(environmentFilename, 'utf8'));
  const validatorSignature = /export\s+function\s+isCanonicalHttpsOrigin\s*\([^)]*\)/.exec(
    environment
  );
  let validatorBlock = '';
  if (validatorSignature) {
    const open = environment.indexOf('{', validatorSignature.index);
    const close = findMatching(environment, open, '{', '}');
    if (open >= 0 && close > open) validatorBlock = environment.slice(open + 1, close);
  }
  const suffixes = ['.invalid', '.localhost', '.local', '.test'];
  const validatorIsScoped = /\bCANONICAL_HTTPS_ORIGIN\s*\.\s*test\s*\(\s*value\s*\)/.test(
    validatorBlock
  ) && suffixes.every(suffix => new RegExp(
    `hostname\\s*\\.\\s*endsWith\\s*\\(\\s*['"]\\${suffix}['"]\\s*\\)`
  ).test(validatorBlock));

  const assertSignature = /static\s+assertUsable\s*\([^)]*\)/.exec(environment);
  let assertBlock = '';
  if (assertSignature) {
    const open = environment.indexOf('{', assertSignature.index);
    const close = findMatching(environment, open, '{', '}');
    if (open >= 0 && close > open) assertBlock = environment.slice(open + 1, close);
  }
  if (!validatorIsScoped
      || !/if\s*\(\s*!\s*isCanonicalHttpsOrigin\s*\(\s*ApiEnvironment\.API_ORIGIN\s*\)\s*\)/.test(
        assertBlock
      )
      || !/throw\s+new\s+Error\s*\(\s*['"]LOCAL_ENVIRONMENT_INVALID['"]\s*\)/.test(
        assertBlock
      )) {
    errors.push('entry/src/main: enabled profiles must validate a canonical HTTPS origin');
  }

  const origin = /\bstatic\s+readonly\s+API_ORIGIN\s*:\s*string\s*=\s*(['"])([^'"]+)\1\s*;/.exec(
    environment
  );
  if (!origin || origin[2] !== 'https://harmony-child.invalid') {
    errors.push('entry/src/main: tracked API_ORIGIN must remain a reserved .invalid origin');
  }
  const profile = /\bstatic\s+readonly\s+PROFILE\s*:\s*string\s*=\s*(['"])([^'"]+)\1\s*;/.exec(
    environment
  );
  if (!profile || profile[2] !== 'develop-blocked') {
    errors.push('entry/src/main: tracked environment profile must remain develop-blocked');
  }
  return errors;
}

function normalizeApiPath(value) {
  let endpoint = value.trim().split(/[?#]/, 1)[0];
  if (/^\/v[12]\//.test(endpoint)) endpoint = `/api${endpoint}`;
  return endpoint;
}

function isAllowedApiPath(value) {
  const endpoint = normalizeApiPath(value);
  if (allowedApiPaths.has(endpoint)) return true;
  return /^\/api\/v2\/devices\/\$\{[A-Za-z_$][^}]*\}\/session-challenges$/.test(endpoint)
    || /^\/api\/v2\/me\/point-requests\/\$\{[A-Za-z_$][^}]*\}$/.test(endpoint);
}

function requestVariableCarriesIdentity(source, identifier, beforeIndex) {
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${identifier}\\s*(?::[^=;]+)?=\\s*\\{`, 'g');
  let match;
  let latest;
  while ((match = declaration.exec(source)) && match.index < beforeIndex) latest = match;
  if (!latest) return false;
  const openIndex = source.indexOf('{', latest.index);
  const closeIndex = findMatching(source, openIndex, '{', '}');
  if (closeIndex < 0 || closeIndex > beforeIndex) return false;
  return identitySelectorPattern.test(source.slice(openIndex, closeIndex + 1));
}

function checkApiBoundary(harmonyRoot, files) {
  const errors = [];
  const requestPattern = /\b(?:request|requestJson|sendRequest|executeRequest|postJson|patchJson)\s*(?:<[^;()]*>)?\s*\(/g;
  for (const filename of files.filter(value => /\.(?:ets|ts|js)$/i.test(value))) {
    const source = fs.readFileSync(filename, 'utf8');
    for (const literal of stringLiterals(source)) {
      const candidate = literal.body.trim();
      if (!candidate.startsWith('/api/') && !/^\/v[12]\//.test(candidate)) continue;
      if (!isAllowedApiPath(candidate)) {
        errors.push(`${relative(harmonyRoot, filename)}: API path is outside the child-device allowlist: ${candidate.split(/[?#]/, 1)[0]}`);
      } else if (normalizeApiPath(candidate) === '/api/v2/point-requests'
          && relative(harmonyRoot, filename) !== 'entry/src/main/ets/network/ApiClient.ets') {
        errors.push(`${relative(harmonyRoot, filename)}: point creation path must stay inside the method-scoped API client`);
      } else if ((normalizeApiPath(candidate).startsWith('/api/v2/me/point-request-operations/')
          || /^\/api\/v2\/me\/point-requests\/\$\{/.test(normalizeApiPath(candidate)))
          && relative(harmonyRoot, filename) !== 'entry/src/main/ets/network/ApiClient.ets') {
        errors.push(`${relative(harmonyRoot, filename)}: point detail and operation reconciliation paths must stay inside the method-scoped API client`);
      }
    }
    for (const call of callExpressions(source, requestPattern)) {
      if (source.slice(call.end + 1).trimStart().startsWith('{')) continue;
      if (identitySelectorPattern.test(call.text)) {
        errors.push(`${relative(harmonyRoot, filename)}: business request contains a client-selected identity field`);
        continue;
      }
      const identifiers = new Set();
      for (const pattern of [
        /JSON\.stringify\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g,
        /\b(?:body|data|payload)\s*:\s*([A-Za-z_$][\w$]*)\b/g,
        /\b([A-Za-z_$][\w$]*)\b/g
      ]) {
        let match;
        while ((match = pattern.exec(call.text))) identifiers.add(match[1]);
      }
      if ([...identifiers].some(identifier => requestVariableCarriesIdentity(source, identifier, call.start))) {
        errors.push(`${relative(harmonyRoot, filename)}: business request variable contains a client-selected identity field`);
      }
    }
  }
  return errors;
}

function checkPointRequestReadOnlyBoundary(harmonyRoot, files) {
  const errors = [];
  const targets = [indexPageRelative, childSessionCoordinatorRelative];
  const reconciliationConsumption = /\breconcilePointRequestOperation\b|\b(?:parse|serialize|validate|copy)?PointRequestOperation[A-Za-z0-9_]*\b|\/api\/v2\/me\/point-request-operations\/(?:resubmit|cancel)\/reconcile\b/;
  const mutationConsumption = /\b(?:resubmit|cancel)PointRequest[A-Za-z0-9_]*\b|\bpointRequest(?:Resubmit|Cancel)[A-Za-z0-9_]*\b|\b(?:resubmit|cancel)\s*\(|['"`](?:resubmit|cancel)['"`]|\bPATCH\b|\/api\/v2\/point-requests\//;

  for (const target of targets) {
    const filename = path.join(harmonyRoot, target);
    const displayName = relative(harmonyRoot, filename);
    if (!files.includes(filename)) {
      errors.push(`${displayName}: S20b point-request read-only boundary target is required`);
      continue;
    }
    const source = codeWithoutComments(fs.readFileSync(filename, 'utf8'));
    if (reconciliationConsumption.test(source)) {
      errors.push(`${displayName}: S20b UI/coordinator must not consume point-request operation reconciliation or PointRequestOperation DTOs`);
    }
    if (mutationConsumption.test(source)) {
      errors.push(`${displayName}: S20b UI/coordinator must not consume point-request resubmit/cancel mutation methods or endpoints`);
    }
  }
  return errors;
}

function checkMethodScopedMutation(harmonyRoot, files) {
  const hasPointCreationPath = files.some(filename => stringLiterals(
    fs.readFileSync(filename, 'utf8')
  ).some(literal => normalizeApiPath(literal.body) === '/api/v2/point-requests'));
  if (!hasPointCreationPath) return [];
  const filename = path.join(
    harmonyRoot, 'entry', 'src', 'main', 'ets', 'network', 'ApiClient.ets'
  );
  if (!files.includes(filename)) {
    return ['entry/src/main/ets/network/ApiClient.ets: method-scoped point creation gate is required'];
  }
  const source = codeWithoutComments(fs.readFileSync(filename, 'utf8'));
  const pointBlock = /value\.path\s*===\s*['"]\/api\/v2\/point-requests['"][\s\S]{0,500}value\.method\s*===\s*['"]POST['"][\s\S]{0,500}value\.mutating[\s\S]{0,500}accessBearer\s*\(\s*value\.bearer\s*\)[\s\S]{0,500}validIdempotencyKey\s*\(\s*value\.idempotencyKey\s*\)/;
  if (!/export\s+function\s+isAllowedTransportRequest\s*\(/.test(source)
      || !pointBlock.test(source)) {
    return ['entry/src/main/ets/network/ApiClient.ets: point creation must require POST, Access bearer, mutation mode and idempotency'];
  }
  return [];
}

function checkPrivacySafetyShell(harmonyRoot, files) {
  const errors = [];
  const shellFilename = path.join(harmonyRoot, privacyShellRelative);
  const indexFilename = path.join(harmonyRoot, indexPageRelative);
  const mainPagesFilename = path.join(harmonyRoot, mainPagesRelative);

  if (!files.includes(shellFilename)) {
    errors.push('entry/src/main: local privacy safety shell is required');
  } else {
    const rawSource = fs.readFileSync(shellFilename, 'utf8');
    const source = codeWithoutComments(rawSource);
    const shellStructure = codeStructureMask(source);
    const exportedNames = [...shellStructure.matchAll(
      /\bexport\s+(?:const|interface|function|class|type|enum)\s+([A-Za-z_$][\w$]*)/g
    )].map(match => match[1]).sort();
    const allowedExports = [
      'PRIVACY_SAFETY_BOUNDARY',
      'PRIVACY_SAFETY_SHELL_MARKER',
      'PrivacySafetySection',
      'PrivacySafetySetting',
      'privacySafetySections',
      'privacySafetySettings'
    ].sort();
    const declaredFunctions = [...shellStructure.matchAll(
      /\b(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g
    )].map(match => match[1]).sort();
    const declaredConstants = [...shellStructure.matchAll(
      /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)/g
    )].map(match => match[1]).sort();
    if (exportedNames.join('|') !== allowedExports.join('|')
        || declaredFunctions.join('|') !== 'privacySafetySections|privacySafetySettings'
        || declaredConstants.join('|') !== 'PRIVACY_SAFETY_BOUNDARY|PRIVACY_SAFETY_SHELL_MARKER'
        || /\bexport\s+(?:default\b|\{|\*|namespace\b|module\b)/.test(shellStructure)
        || /\b(?:let|var)\s+[A-Za-z_$]/.test(shellStructure)
        || /=>/.test(shellStructure)
        || hasUnexpectedBareCall(shellStructure, new Set([
          'privacySafetySections',
          'privacySafetySettings'
        ]))
        || hasUnexpectedMemberCallRoot(shellStructure, new Set())
        || !/export\s+function\s+privacySafetySettings\s*\(\s*networkEnabled\s*:\s*boolean\s*\)\s*:\s*Array<PrivacySafetySetting>/.test(shellStructure)
        || !/export\s+function\s+privacySafetySections\s*\(\s*\)\s*:\s*Array<PrivacySafetySection>/.test(shellStructure)) {
      errors.push('entry/src/main: privacy safety shell must expose only fixed local data builders');
    }
    if (!/S10_LOCAL_SAFETY_SHELL_NOT_FORMAL_LEGAL_TEXT/.test(source)
        || !/不是正式隐私政策/.test(source)
        || !/儿童生产功能保持关闭/.test(source)) {
      errors.push('entry/src/main: privacy safety shell must remain explicitly non-formal');
    }
    if (/\bimport\s+/.test(source)
        || /\/\/|\/\*/.test(rawSource)
        || /https?:\/\//i.test(source)
        || /\/api\//i.test(source)
        || privacySideEffectPattern.test(source)
        || /\b(?:async|Promise)\b/.test(source)) {
      errors.push('entry/src/main: privacy safety shell must remain local-only without navigation, network or storage code');
    }
    if (/\b(?:childName|familyId|childId|adultId|guardianId|userId|role|deviceId|devicePublicId|deviceBindingId|bindingId|sessionId|accessToken|refreshToken|publicKey|shortCode)\b/i.test(source)) {
      errors.push('entry/src/main: privacy safety shell must not accept or expose dynamic identity or session data');
    }
    if (/(?:\b1[3-9]\d{9}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|我同意|接受并继续|已完成备案|已完成合规|立即完整删除|永久保存)/i.test(source)) {
      errors.push('entry/src/main: privacy safety shell must not contain fake legal, contact or retention claims');
    }
  }

  if (!files.includes(indexFilename)) {
    errors.push('entry/src/main: Index.ets must expose the local privacy safety shell');
  } else {
    const rawIndexSource = fs.readFileSync(indexFilename, 'utf8');
    const indexSource = codeWithoutComments(rawIndexSource);
    const indexStructure = codeStructureMask(indexSource);
    const indexImports = [];
    const indexImportPattern = /(?:^|\n)\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;/g;
    let indexImportMatch;
    while ((indexImportMatch = indexImportPattern.exec(indexSource))) {
      const keywordIndex = indexSource.indexOf('import', indexImportMatch.index);
      if (indexStructure.slice(keywordIndex, keywordIndex + 6) !== 'import') continue;
      const names = indexImportMatch[1].split(',').map(value => value.trim()).sort();
      indexImports.push(`${indexImportMatch[2]}:${names.join(',')}`);
    }
    const expectedIndexImports = [
      '../config/ApiEnvironment:ApiEnvironment',
      '../network/ApiClient:ChildApiClient,HarmonyHttpTransport',
      '../network/ApiContracts:PointRequestDto,RewardRuleDto,TransactionDto',
      '../privacy/PrivacySafetyShell:PRIVACY_SAFETY_BOUNDARY,PrivacySafetySection,PrivacySafetySetting,privacySafetySections,privacySafetySettings',
      '../security/DeviceIdentity:DeviceIdentity',
      '../security/PointRequestVault:PointRequestVault',
      '../security/SessionVault:SessionVault',
      '../session/ChildSessionCoordinator:ChildSessionCoordinator,StrictDeviceProofVerifier,StrictSecureIdGenerator',
      '../session/SessionEnvelope:EnvelopePhase'
    ].sort();
    const indexImportsValid = indexImports.sort().join('|') === expectedIndexImports.join('|');
    const entryStructMatch = /@Entry\s*@Component\s*struct\s+Index\s*\{/.exec(indexStructure);
    let moduleShapeValid = false;
    if (entryStructMatch) {
      const structOpen = indexStructure.indexOf('{', entryStructMatch.index);
      const structClose = findMatching(indexStructure, structOpen, '{', '}');
      const prefix = indexStructure.slice(0, entryStructMatch.index).replace(
        /(?:^|\n)\s*import\s*\{[^}]*\}\s*from\s*[^;]*;/g,
        ''
      );
      const suffix = structClose >= 0 ? indexStructure.slice(structClose + 1) : indexStructure;
      moduleShapeValid = prefix.trim() === '' && suffix.trim() === '';
    }
    const indexBlock = namedStructBlock(indexSource, 'Index');
    const privateMethod = name => topLevelMethodDetails(indexBlock, name, true);
    const lifecycleMethod = name => topLevelMethodDetails(indexBlock, name, false);
    const privacySettingRowMethod = privateMethod('privacySettingRow');
    const privacySectionCardMethod = privateMethod('privacySectionCard');
    const privacySafetyShellMethod = privateMethod('privacySafetyShell');
    const toggleMethod = privateMethod('togglePrivacySafety');
    const clearPointDraftMethod = privateMethod('clearPointDraft');
    const networkReadyMethod = privateMethod('networkReady');
    const headerMethod = privateMethod('header');
    const buildMethod = lifecycleMethod('build');
    const hideMethod = lifecycleMethod('onPageHide');
    if (!indexImportsValid
        || !indexBlock
        || !moduleShapeValid
        || (indexStructure.match(/@Entry\b/g) || []).length !== 1
        || (indexStructure.match(/@Entry\s*@Component\s*struct\s+Index\s*\{/g) || []).length !== 1
        || !/@State\s+showPrivacySafety\s*:\s*boolean\s*=\s*false/.test(indexBlock)
        || !privacySafetyShellMethod
        || privacySafetyShellMethod.signature !== 'private privacySafetyShell()'
        || !/设置与隐私/.test(indexBlock)
        || !/this\.showPrivacySafety\s*\?\s*['"]纯本地说明，不读取或改变配对状态['"]/.test(
          indexBlock
        )) {
      errors.push('entry/src/main: Index.ets must expose the privacy safety shell as a local view');
    }
    const toggleBlock = toggleMethod ? toggleMethod.body : '';
    const clearPointDraftBlock = clearPointDraftMethod ? clearPointDraftMethod.body : '';
    if (!toggleMethod || toggleMethod.signature !== 'private togglePrivacySafety(): void'
        || !clearPointDraftMethod
        || clearPointDraftMethod.signature !== 'private clearPointDraft(): void'
        || !/^\s*this\.selectedRuleId\s*=\s*['"]['"]\s*;\s*this\.requestedPoints\s*=\s*['"]['"]\s*;\s*this\.description\s*=\s*['"]['"]\s*;\s*$/.test(
          clearPointDraftBlock
        )
        || !/^\s*this\.shortCode\s*=\s*['"]['"]\s*;\s*this\.clearPointDraft\s*\(\s*\)\s*;\s*this\.showPrivacySafety\s*=\s*!\s*this\.showPrivacySafety\s*;\s*$/.test(
      toggleBlock
    )) {
      errors.push('entry/src/main: privacy safety view toggle must not touch session, network or storage state');
    }
    const renderBlocks = [
      privacySettingRowMethod ? privacySettingRowMethod.body : '',
      privacySectionCardMethod ? privacySectionCardMethod.body : '',
      privacySafetyShellMethod ? privacySafetyShellMethod.body : ''
    ];
    const renderSource = renderBlocks.join('\n');
    const allowedThisReferences = new Set([
      'networkReady',
      'privacySettingRow',
      'privacySectionCard'
    ]);
    const unsafeThisReference = thisMemberNames(renderSource)
      .some(name => !allowedThisReferences.has(name));
    const networkReadyBlock = networkReadyMethod ? networkReadyMethod.body : '';
    if (renderBlocks.some(block => block.length === 0)
        || !privacySettingRowMethod
        || privacySettingRowMethod.signature !== 'private privacySettingRow(setting: PrivacySafetySetting)'
        || !privacySectionCardMethod
        || privacySectionCardMethod.signature !== 'private privacySectionCard(section: PrivacySafetySection)'
        || !privacySafetyShellMethod
        || privacySafetyShellMethod.signature !== 'private privacySafetyShell()'
        || !networkReadyMethod
        || networkReadyMethod.signature !== 'private networkReady(): boolean'
        || unsafeThisReference
        || !/^\s*return\s+ApiEnvironment\.NETWORK_ENABLED\s*;\s*$/.test(networkReadyBlock)
        || /\/\/|\/\*/.test(rawIndexSource)
        || /https?:\/\//i.test(renderSource)
        || /\/api\//i.test(renderSource)
        || privacySideEffectPattern.test(renderSource)
        || privacyDynamicDataPattern.test(renderSource)
        || hasUnsafeThisSyntax(renderSource)
        || /`/.test(renderSource.replace(/`\$\{section\.id\}-\$\{index\}`/g, ''))
        || hasUnexpectedBareCall(renderSource, new Set([
          'Column',
          'ForEach',
          'Row',
          'Text',
          'privacySafetySections',
          'privacySafetySettings'
        ]))
        || hasUnexpectedMemberCallRoot(renderSource, new Set(['this']))
        || hasUnexpectedFreeIdentifier(renderSource, new Set([
          'Column',
          'FontWeight',
          'ForEach',
          'HorizontalAlign',
          'PRIVACY_SAFETY_BOUNDARY',
          'PrivacySafetySection',
          'PrivacySafetySetting',
          'Row',
          'Text',
          'VerticalAlign',
          '_item',
          'index',
          'item',
          'number',
          'privacySafetySections',
          'privacySafetySettings',
          'section',
          'setting',
          'space',
          'string',
          'this'
        ]))
        || /\bButton\s*\(|\.on[A-Z][A-Za-z]*\s*\(/.test(renderSource)) {
      errors.push('entry/src/main: privacy safety builders must render fixed local content without actions or session data');
    }
    const headerBlock = headerMethod ? headerMethod.body : '';
    const buildBlock = buildMethod ? buildMethod.body : '';
    const headerClickCount = (headerBlock.match(/\.onClick\s*\(/g) || []).length;
    const headerEventCount = (headerBlock.match(/\.on[A-Z][A-Za-z]*\s*\(/g) || []).length;
    const headerStatusCount = (headerBlock.match(/this\.statusText\s*\(/g) || []).length;
    const headerToggleCount = (headerBlock.match(/this\.togglePrivacySafety\s*\(/g) || []).length;
    const allowedHeaderThisReferences = new Set([
      'showPrivacySafety',
      'statusText',
      'togglePrivacySafety'
    ]);
    const unsafeHeaderThisReference = thisMemberNames(headerBlock)
      .some(name => !allowedHeaderThisReferences.has(name));
    if (!headerMethod || headerMethod.signature !== 'private header()'
        || unsafeHeaderThisReference
        || headerStatusCount !== 1
        || headerToggleCount !== 1
        || privacySideEffectPattern.test(headerBlock)
        || privacyDynamicDataPattern.test(headerBlock)
        || hasUnsafeThisSyntax(headerBlock)
        || hasUnexpectedBareCall(headerBlock, new Set(['Button', 'Column', 'Text']))
        || hasUnexpectedMemberCallRoot(headerBlock, new Set(['this']))
        || hasUnexpectedFreeIdentifier(headerBlock, new Set([
          'Button',
          'Column',
          'FontWeight',
          'Text',
          'TextAlign',
          'bottom',
          'space',
          'this',
          'top'
        ]))
        || !/this\.showPrivacySafety\s*\?\s*['"]纯本地说明，不读取或改变配对状态['"]\s*:\s*this\.statusText\s*\(\s*\)/.test(
          headerBlock
        )) {
      errors.push('entry/src/main: privacy safety header must not expose business or session state');
    }
    if (headerClickCount !== 1 || headerEventCount !== 1
        || !/\.onClick\s*\(\s*\(\s*\)\s*=>\s*this\.togglePrivacySafety\s*\(\s*\)\s*\)/.test(
          headerBlock
        )) {
      errors.push('entry/src/main: privacy safety entry must bind only the local toggle');
    }
    const shellIf = /if\s*\(\s*this\.showPrivacySafety\s*\)/.exec(buildBlock);
    let shellBranchValid = false;
    if (shellIf && buildMethod && buildMethod.signature === 'build()') {
      const trueOpen = buildBlock.indexOf('{', shellIf.index);
      const trueClose = findMatching(buildBlock, trueOpen, '{', '}');
      const afterTrue = trueClose >= 0 ? buildBlock.slice(trueClose + 1) : '';
      const elseMatch = /^\s*else\s*/.exec(afterTrue);
      const elseStart = elseMatch ? trueClose + 1 : -1;
      const elseOpen = elseStart >= 0 ? buildBlock.indexOf('{', elseStart) : -1;
      const elseClose = findMatching(buildBlock, elseOpen, '{', '}');
      if (trueOpen >= 0 && trueClose > trueOpen && elseOpen > trueClose
          && elseClose > elseOpen) {
        const trueBlock = buildBlock.slice(trueOpen + 1, trueClose);
        const outside = buildBlock.slice(0, shellIf.index)
          + buildBlock.slice(elseClose + 1);
        const outsideThisReferences = thisMemberNames(outside);
        shellBranchValid = /^\s*this\.privacySafetyShell\s*\(\s*\)\s*;?\s*$/.test(
          trueBlock
        )
          && (buildBlock.match(/this\.privacySafetyShell\s*\(/g) || []).length === 1
          && outsideThisReferences.every(name => name === 'header')
          && !privacySideEffectPattern.test(outside)
          && !privacyDynamicDataPattern.test(outside)
          && !hasUnsafeThisSyntax(outside)
          && !hasUnexpectedBareCall(outside, new Set(['Column', 'Scroll', 'Text']))
          && !hasUnexpectedMemberCallRoot(outside, new Set(['this']))
          && !hasUnexpectedFreeIdentifier(outside, new Set([
            'BarState',
            'Column',
            'Scroll',
            'Text',
            'TextAlign',
            'bottom',
            'left',
            'right',
            'space',
            'this',
            'top'
          ]))
          && !/\b(?:childName|balance|transactions|rewardRules|pointRequests|phase|statusCode|coordinator|api|vault|identity|fetch|request|router|getRouter)\b/i.test(
            outside
          );
      }
    }
    if (!shellBranchValid) {
      errors.push('entry/src/main: privacy safety build must isolate the shell from every business view');
    }
    const hideBlock = hideMethod ? hideMethod.body : '';
    if (!hideMethod || hideMethod.signature !== 'onPageHide(): void'
        || !/^\s*this\.shortCode\s*=\s*['"]['"]\s*;\s*this\.clearPointDraft\s*\(\s*\)\s*;\s*this\.showPrivacySafety\s*=\s*false\s*;\s*this\.coordinator\.lockForBackground\s*\(\s*\)\s*;\s*this\.syncView\s*\(\s*\)\s*;\s*$/.test(
      hideBlock
    )) {
      errors.push('entry/src/main: privacy safety shell must reset when the page is hidden');
    }
  }

  if (!files.includes(mainPagesFilename)) {
    errors.push('entry/src/main: main_pages.json is required');
  } else {
    try {
      const pages = JSON.parse(fs.readFileSync(mainPagesFilename, 'utf8'));
      if (!pages || !Array.isArray(pages.src)
          || pages.src.length !== 1 || pages.src[0] !== 'pages/Index') {
        errors.push('entry/src/main: privacy safety shell must not add a route or second entry page');
      }
    } catch (error) {
      errors.push('entry/src/main: main_pages.json must remain valid JSON');
    }
  }
  return errors;
}

function scan(options = {}) {
  const harmonyRoot = path.resolve(options.harmonyRoot || defaultHarmonyRoot);
  const mainRoot = path.join(harmonyRoot, mainSourceRelative);
  if (!fs.existsSync(mainRoot) || !fs.statSync(mainRoot).isDirectory()) {
    return ['entry/src/main: HarmonyOS main source directory is missing'];
  }
  const files = sourceFiles(harmonyRoot);
  return [
    ...checkBackupPolicy(harmonyRoot),
    ...checkPermissions(harmonyRoot),
    ...checkProductionAndDiagnosticRoutes(harmonyRoot, files),
    ...checkForbiddenStorageAndDeviceApis(harmonyRoot, files),
    ...checkDynamicLogging(harmonyRoot, files),
    ...checkEmbeddedCredentials(harmonyRoot, files),
    ...checkSecurityPrimitives(harmonyRoot, files),
    ...checkEnvironmentPolicy(harmonyRoot, files),
    ...checkApiBoundary(harmonyRoot, files),
    ...checkPointRequestReadOnlyBoundary(harmonyRoot, files),
    ...checkMethodScopedMutation(harmonyRoot, files),
    ...checkPrivacySafetyShell(harmonyRoot, files)
  ];
}

if (require.main === module) {
  const errors = scan();
  if (errors.length) {
    errors.forEach(error => process.stderr.write(`${error}\n`));
    process.exitCode = 1;
  } else {
    process.stdout.write('HarmonyOS security checks passed\n');
  }
}

module.exports = {
  scan,
  sourceFiles,
  checkBackupPolicy,
  checkPermissions,
  checkProductionAndDiagnosticRoutes,
  checkForbiddenStorageAndDeviceApis,
  checkDynamicLogging,
  checkEmbeddedCredentials,
  checkSecurityPrimitives,
  checkEnvironmentPolicy,
  checkApiBoundary,
  checkPointRequestReadOnlyBoundary,
  checkMethodScopedMutation,
  checkPrivacySafetyShell,
  isAllowedApiPath
};
