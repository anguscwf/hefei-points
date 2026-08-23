// API origins are code-reviewed build inputs. Never read an override from storage, query strings or user data.
var PRODUCTION_API_BASE = 'https://hefeijifen.cn';
// No approved non-production service exists yet. The reserved .invalid origin keeps preview builds fail closed.
var NONPRODUCTION_API_BASE = 'https://synthetic-api.invalid';
var NONPRODUCTION_API_CONFIGURED = false;
var BLOCKED_API_BASE = 'https://blocked.invalid';

function originParts(value) {
  if (typeof value !== 'string') return null;
  var match = /^https:\/\/([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(value);
  if (!match) return null;
  var hostname = match[1].toLowerCase().replace(/\.+$/, '');
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
  return !!parts && parts.hostname === 'hefeijifen.cn';
}

function profile(value) {
  return typeof Object.freeze === 'function' ? Object.freeze(value) : value;
}

function nonproductionProfile(envVersion) {
  var apiBase = normalizedOrigin(NONPRODUCTION_API_BASE);
  var ready = NONPRODUCTION_API_CONFIGURED === true
    && !!apiBase
    && !isProductionOrigin(apiBase)
    && !/\.invalid$/i.test(apiBase);
  return profile({
    envVersion: envVersion,
    apiBase: ready ? apiBase : BLOCKED_API_BASE,
    production: false,
    environmentReady: ready,
    guardianPreviewEnabled: ready,
    legalOrigin: ready ? apiBase : BLOCKED_API_BASE,
    legalPathPrefix: '/legal/'
  });
}

function resolve(envVersion) {
  if (envVersion === 'release') {
    return profile({
      envVersion: 'release',
      apiBase: PRODUCTION_API_BASE,
      production: true,
      environmentReady: true,
      guardianPreviewEnabled: false,
      legalOrigin: PRODUCTION_API_BASE,
      legalPathPrefix: '/legal/'
    });
  }
  if (envVersion === 'develop' || envVersion === 'trial') {
    return nonproductionProfile(envVersion);
  }
  return profile({
    envVersion: 'unknown',
    apiBase: BLOCKED_API_BASE,
    production: false,
    environmentReady: false,
    guardianPreviewEnabled: false,
    legalOrigin: BLOCKED_API_BASE,
    legalPathPrefix: '/legal/'
  });
}

module.exports = {
  resolve: resolve,
  isProductionOrigin: isProductionOrigin
};
