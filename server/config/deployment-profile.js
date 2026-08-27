const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');

const PRODUCTION_API_ORIGIN = 'https://hefeijifen.cn';
const PRODUCTION_WECHAT_APP_ID = 'wx90237ce600b51eea';
const SYNTHETIC_RUNTIME_ACK = 'synthetic-api-runtime-v1';
const SYNTHETIC_APP_CREDENTIALS_ACK = 'independent-synthetic-wechat-v1';
const SYNTHETIC_DATA_ACK = 'synthetic-data-only-v1';
const CORE_SYNTHETIC_GATES = Object.freeze([
  'HARMONY_CHILD_ENABLED',
  'CHILD_ENROLLMENT_ENABLED',
  'DEVICE_PAIRING_ENABLED',
  'POINT_REQUESTS_ENABLED'
]);
const CLOSED_SYNTHETIC_GATES = Object.freeze([
  'CHILD_DATA_RIGHTS_ENABLED',
  'LEGACY_CHILD_LOGIN_ENABLED',
  'LEGACY_CHILD_MANAGEMENT_ENABLED'
]);
const PRODUCTION_LOCKED_CHILD_GATES = Object.freeze([
  ...CORE_SYNTHETIC_GATES,
  ...CLOSED_SYNTHETIC_GATES
]);
const PRODUCTION_LOCKED_LEGAL_CONFIG = Object.freeze([
  'LEGAL_PUBLIC_ORIGIN',
  'GUARDIAN_RELATION_DECLARATION_VERSION',
  'GUARDIAN_RELATION_DECLARATION_SHA256',
  'GUARDIAN_RELATION_DECLARATION_PUBLIC_URL'
]);
const RESERVED_ORIGIN_SUFFIXES = Object.freeze([
  '.invalid', '.localhost', '.local', '.test'
]);
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SYNTHETIC_DATASET_ID = /^synthetic-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SYNTHETIC_ROOT_BASENAME = /^tangguan-synthetic-[a-z0-9](?:[a-z0-9-]{4,62}[a-z0-9])?$/;
const IPV4_MAPPED_IPV6 = new net.BlockList();
IPV4_MAPPED_IPV6.addSubnet('::ffff:0.0.0.0', 96, 'ipv6');
const IPV6_UNSPECIFIED = new net.BlockList();
IPV6_UNSPECIFIED.addAddress('::', 'ipv6');
const IPV6_MULTICAST = new net.BlockList();
IPV6_MULTICAST.addSubnet('ff00::', 8, 'ipv6');

class DeploymentConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeploymentConfigError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DeploymentConfigError(code, message);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sensitiveConfigurationBinding({
  apiOrigin,
  datasetId,
  proxyPolicy,
  wechatAppId,
  wechatSecret
}) {
  const publicContext = {
    schemaVersion: 1,
    purpose: 'synthetic-sensitive-configuration-context-v1',
    apiOriginSha256: sha256(apiOrigin),
    datasetIdSha256: sha256(datasetId),
    wechatAppIdSha256: sha256(wechatAppId),
    proxyMode: proxyPolicy.mode,
    trustedProxySetSha256: proxyPolicy.trustedProxySetSha256
  };
  const appSecretKeyedProofSha256 = crypto.createHmac('sha256', wechatSecret)
    .update(JSON.stringify(publicContext))
    .digest('hex');
  return sha256(JSON.stringify({
    schemaVersion: 1,
    purpose: 'synthetic-sensitive-configuration-binding-v1',
    publicContext,
    appSecretKeyedProofSha256
  }));
}

function canonicalPublicHttpsOrigin(value) {
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
      || net.isIP(parsed.hostname) !== 0) {
    return false;
  }
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
    parsed.hostname
  )) {
    return false;
  }
  return !RESERVED_ORIGIN_SUFFIXES.some(suffix => parsed.hostname.endsWith(suffix));
}

function isProductionOrigin(value) {
  try {
    const hostname = new URL(value).hostname;
    return hostname === 'hefeijifen.cn' || hostname.endsWith('.hefeijifen.cn');
  } catch (_) {
    return false;
  }
}

function isWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function canonicalAbsolutePath(value) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)) return null;
  if (process.platform === 'win32' && value.replaceAll('/', '\\').startsWith('\\\\')) return null;
  if (value.includes('\0') || path.normalize(value) !== value) return null;
  const parsed = path.parse(value);
  const segments = value.substring(parsed.root.length).split(path.sep).filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..'
      || /[. ]$/.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment))) {
    return null;
  }
  return path.resolve(value);
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function validProxy(value) {
  const slash = value.indexOf('/');
  const address = slash < 0 ? value : value.substring(0, slash);
  const family = net.isIP(address);
  if (!family) return false;
  if (address === '0.0.0.0' || address === '255.255.255.255'
      || (family === 4 && Number(address.split('.')[0]) >= 224)
      || (family === 6 && (IPV6_UNSPECIFIED.check(address, 'ipv6')
        || IPV6_MULTICAST.check(address, 'ipv6')
        || IPV4_MAPPED_IPV6.check(address, 'ipv6')))) {
    return false;
  }
  if (slash < 0) return true;
  const prefix = value.substring(slash + 1);
  if (!/^(?:0|[1-9][0-9]{0,2})$/.test(prefix)) return false;
  const bits = Number(prefix);
  if (family === 4) return bits >= 24 && bits <= 32;
  if (bits < 64 || bits > 128) return false;
  const candidate = new net.BlockList();
  candidate.addSubnet(address, bits, 'ipv6');
  return !candidate.check('::ffff:203.0.113.10', 'ipv6');
}

function validateProxyPolicy(environment) {
  const mode = String(environment.PAIRING_CLIENT_IP_MODE || '').trim();
  const proxies = String(environment.TRUSTED_PROXIES || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (mode === 'direct') {
    if (proxies.length) {
      fail('SYNTHETIC_PROXY_POLICY_INVALID', 'direct pairing mode must not name trusted proxies');
    }
    return Object.freeze({
      mode,
      trustedProxyCount: 0,
      trustedProxySetSha256: sha256(JSON.stringify([]))
    });
  }
  if (mode !== 'trusted_proxy' || proxies.length === 0 || !proxies.every(validProxy)) {
    fail('SYNTHETIC_PROXY_POLICY_INVALID', 'synthetic pairing proxy policy is invalid');
  }
  const normalized = [...proxies].sort();
  if (new Set(normalized).size !== normalized.length) {
    fail('SYNTHETIC_PROXY_POLICY_INVALID', 'synthetic trusted proxies must be unique');
  }
  return Object.freeze({
    mode,
    trustedProxyCount: normalized.length,
    trustedProxySetSha256: sha256(JSON.stringify(normalized))
  });
}

function validateSyntheticDataPaths(environment, projectRoot) {
  const root = canonicalAbsolutePath(environment.SYNTHETIC_DATA_ROOT);
  const dataDir = canonicalAbsolutePath(environment.DATA_DIR);
  const sqliteFile = canonicalAbsolutePath(environment.SQLITE_FILE);
  const canonicalProjectRoot = path.resolve(projectRoot);
  if (!root || !dataDir || !sqliteFile
      || !SYNTHETIC_ROOT_BASENAME.test(path.basename(root))
      || isWithin(canonicalProjectRoot, root)
      || isWithin(root, canonicalProjectRoot)
      || !samePath(dataDir, path.join(root, 'data'))
      || !samePath(sqliteFile, path.join(dataDir, 'hefei-points-synthetic.sqlite'))
      || String(environment.PRE_MIGRATION_BACKUP_MANIFEST || '').trim()) {
    fail('SYNTHETIC_DATA_ROOT_UNSAFE', 'synthetic data path shape is unsafe');
  }
  return Object.freeze({ root, dataDir, sqliteFile });
}

function validateSyntheticLegalSource(environment, apiOrigin) {
  const legalOrigin = String(environment.LEGAL_PUBLIC_ORIGIN || '').trim();
  if (legalOrigin !== apiOrigin) {
    fail('SYNTHETIC_LEGAL_SOURCE_INVALID', 'synthetic legal origin must equal the API origin');
  }
  const version = String(environment.GUARDIAN_RELATION_DECLARATION_VERSION || '').trim();
  const sha256 = String(environment.GUARDIAN_RELATION_DECLARATION_SHA256 || '').trim();
  const publicUrl = String(environment.GUARDIAN_RELATION_DECLARATION_PUBLIC_URL || '').trim();
  const expected = `${apiOrigin}/legal/guardian-relation-declaration/${version}/${sha256}.html`;
  if (!VERSION.test(version) || !SHA256.test(sha256) || publicUrl !== expected) {
    fail('SYNTHETIC_LEGAL_SOURCE_INVALID', 'synthetic guardian declaration evidence is invalid');
  }
  return Object.freeze({ legalOrigin, version, sha256, publicUrl });
}

function validateSyntheticDeployment(environment, options = {}) {
  const projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..');
  if (String(environment.NODE_ENV || '') !== 'production'
      || String(environment.DEPLOYMENT_TIER || '') !== 'synthetic') {
    fail('SYNTHETIC_MODE_REQUIRED', 'synthetic deployment tier requires NODE_ENV=production');
  }
  if (environment.SYNTHETIC_RUNTIME_ACK !== SYNTHETIC_RUNTIME_ACK
      || environment.SYNTHETIC_APP_CREDENTIALS_ACK !== SYNTHETIC_APP_CREDENTIALS_ACK
      || environment.SYNTHETIC_DATA_ACK !== SYNTHETIC_DATA_ACK) {
    fail('SYNTHETIC_ACK_REQUIRED', 'synthetic deployment acknowledgements are incomplete');
  }

  const apiOrigin = String(environment.API_PUBLIC_ORIGIN || '').trim();
  if (!canonicalPublicHttpsOrigin(apiOrigin)) {
    fail('SYNTHETIC_CONFIG_INVALID', 'synthetic API origin shape is invalid');
  }
  if (isProductionOrigin(apiOrigin)) {
    fail('SYNTHETIC_PRODUCTION_RESOURCE_FORBIDDEN', 'production origin is forbidden');
  }

  const wechatAppId = String(environment.WX_APPID || '').trim();
  if (!/^wx[a-f0-9]{16}$/.test(wechatAppId)) {
    fail('SYNTHETIC_CONFIG_INVALID', 'synthetic WeChat AppID shape is invalid');
  }
  if (wechatAppId === PRODUCTION_WECHAT_APP_ID) {
    fail('SYNTHETIC_PRODUCTION_RESOURCE_FORBIDDEN', 'production WeChat AppID is forbidden');
  }
  const wechatSecret = String(environment.WX_APPSECRET || '');
  if (wechatSecret.length < 16 || wechatSecret.length > 512 || /\s/.test(wechatSecret)) {
    fail('SYNTHETIC_CONFIG_INVALID', 'synthetic WeChat secret must be explicitly injected');
  }

  for (const name of CORE_SYNTHETIC_GATES) {
    if (environment[name] !== 'true') {
      fail('SYNTHETIC_FEATURE_GATES_INVALID', 'synthetic core feature gates are incomplete');
    }
  }
  for (const name of CLOSED_SYNTHETIC_GATES) {
    if (environment[name] !== 'false') {
      fail('SYNTHETIC_FEATURE_GATES_INVALID', 'synthetic closed feature gates are invalid');
    }
  }
  if (!SYNTHETIC_DATASET_ID.test(String(environment.SYNTHETIC_DATASET_ID || ''))) {
    fail('SYNTHETIC_CONFIG_INVALID', 'synthetic dataset identifier is invalid');
  }
  if (!['info', 'warn', 'error', 'fatal'].includes(String(environment.LOG_LEVEL || ''))) {
    fail('SYNTHETIC_CONFIG_INVALID', 'synthetic log level must not enable debug output');
  }

  const dataPaths = validateSyntheticDataPaths(environment, projectRoot);
  const proxyPolicy = validateProxyPolicy(environment);
  const legalSource = validateSyntheticLegalSource(environment, apiOrigin);
  const sensitiveConfigurationBindingSha256 = sensitiveConfigurationBinding({
    apiOrigin,
    datasetId: environment.SYNTHETIC_DATASET_ID,
    proxyPolicy,
    wechatAppId,
    wechatSecret
  });
  return Object.freeze({
    deploymentTier: 'synthetic',
    apiOrigin,
    wechatAppId,
    wechatSecretPresent: true,
    sensitiveConfigurationBindingSha256,
    datasetId: environment.SYNTHETIC_DATASET_ID,
    dataPaths,
    proxyPolicy,
    legalSource,
    coreFeatureGatesEnabled: true,
    closedFeatureGatesDisabled: true
  });
}

function validateProductionDeployment(environment) {
  if (String(environment.DEPLOYMENT_TIER || '') !== 'production') {
    fail('DEPLOYMENT_TIER_REQUIRED', 'production deployment tier must be explicit');
  }
  if (String(environment.API_PUBLIC_ORIGIN || '') !== PRODUCTION_API_ORIGIN
      || String(environment.WX_APPID || '') !== PRODUCTION_WECHAT_APP_ID) {
    fail('PRODUCTION_CONFIG_INVALID', 'production public identity is invalid');
  }
  for (const name of [
    'SYNTHETIC_RUNTIME_ACK',
    'SYNTHETIC_APP_CREDENTIALS_ACK',
    'SYNTHETIC_DATA_ACK',
    'SYNTHETIC_DATA_ROOT',
    'SYNTHETIC_DATASET_ID'
  ]) {
    if (String(environment[name] || '').trim()) {
      fail('PRODUCTION_CONFIG_INVALID', 'synthetic configuration must not enter production');
    }
  }
  for (const name of PRODUCTION_LOCKED_CHILD_GATES) {
    if (environment[name] !== 'false') {
      fail('PRODUCTION_CHILD_FEATURES_LOCKED',
        'production child feature gates must remain explicitly closed');
    }
  }
  for (const name of PRODUCTION_LOCKED_LEGAL_CONFIG) {
    if (String(environment[name] || '').trim()) {
      fail('PRODUCTION_LEGAL_FEATURES_LOCKED',
        'production legal publication configuration must remain empty');
    }
  }
  return Object.freeze({
    deploymentTier: 'production',
    apiOrigin: PRODUCTION_API_ORIGIN,
    wechatAppId: PRODUCTION_WECHAT_APP_ID
  });
}

function validateDeployment(environment, options = {}) {
  const nodeEnvironment = String(environment.NODE_ENV || '');
  const deploymentTier = String(environment.DEPLOYMENT_TIER || '');
  if (nodeEnvironment !== 'production') {
    if (deploymentTier && deploymentTier !== 'local') {
      fail('DEPLOYMENT_TIER_INVALID',
        'production and synthetic deployment tiers require NODE_ENV=production');
    }
    return Object.freeze({ deploymentTier: 'local' });
  }
  return environment.DEPLOYMENT_TIER === 'synthetic'
    ? validateSyntheticDeployment(environment, options)
    : validateProductionDeployment(environment);
}

module.exports = {
  CLOSED_SYNTHETIC_GATES,
  CORE_SYNTHETIC_GATES,
  DeploymentConfigError,
  PRODUCTION_LOCKED_CHILD_GATES,
  PRODUCTION_LOCKED_LEGAL_CONFIG,
  PRODUCTION_API_ORIGIN,
  PRODUCTION_WECHAT_APP_ID,
  SYNTHETIC_APP_CREDENTIALS_ACK,
  SYNTHETIC_DATA_ACK,
  SYNTHETIC_RUNTIME_ACK,
  canonicalAbsolutePath,
  canonicalPublicHttpsOrigin,
  isProductionOrigin,
  validateDeployment,
  validateProxyPolicy,
  validateSyntheticDataPaths,
  validateSyntheticDeployment
};
