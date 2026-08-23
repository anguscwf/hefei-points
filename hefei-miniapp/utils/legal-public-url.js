function safePathPrefix(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 256
      || value.charAt(0) !== '/' || value.charAt(value.length - 1) !== '/'
      || /[\\?#\s]/.test(value)) return '';
  return hasUnsafePath(value) ? '' : value;
}

function safeOrigin(value) {
  if (typeof value !== 'string' || value.length < 9 || value.length > 253
      || value.indexOf('https://') !== 0 || /[\\/?#\s]/.test(value.slice(8))) return '';
  var authority = value.slice(8);
  if (!authority || authority.indexOf('@') >= 0 || authority.indexOf(':') >= 0
      || authority.charAt(0) === '.' || authority.charAt(authority.length - 1) === '.') return '';
  if (!/^[A-Za-z0-9.-]+$/.test(authority)) return '';
  return value;
}

function hasUnsafePath(value) {
  var candidate = value;
  for (var pass = 0; pass < 4; pass += 1) {
    if (/[\u0000-\u0020\u007f\\?#]/.test(candidate)) return true;
    var segments = candidate.split('/');
    if (segments.some(function(segment) { return segment === '.' || segment === '..'; })) {
      return true;
    }
    var decoded;
    try {
      decoded = decodeURIComponent(candidate);
    } catch (error) {
      return true;
    }
    if (decoded === candidate) return false;
    candidate = decoded;
  }
  // More than four decoding layers are never part of the public legal URL contract.
  return candidate !== value;
}

var DOCUMENT_PATHS = {
  privacyPolicy: 'privacy-policy',
  childPersonalInformationRules: 'child-personal-information-rules',
  childUserAgreement: 'child-user-agreement',
  sensitiveInformationNotice: 'sensitive-information-notice',
  guardianRelationDeclaration: 'guardian-relation-declaration'
};

function safePublicUrl(value, environment, evidence) {
  if (typeof value !== 'string' || value.length > 2048
      || /[\u0000-\u0020\u007f]/.test(value)) return '';
  var origin = safeOrigin(environment && environment.legalOrigin);
  var pathPrefix = safePathPrefix(environment && environment.legalPathPrefix);
  var documentPath = evidence && DOCUMENT_PATHS[evidence.type];
  var version = evidence && evidence.version;
  var sha256 = evidence && evidence.sha256;
  if (!origin || !pathPrefix || !documentPath
      || typeof version !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(version)
      || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return '';

  var expected = origin + pathPrefix + documentPath + '/' + version + '/' + sha256 + '.html';
  if (value !== expected) return '';
  var path = value.slice(origin.length);
  return !path || /[\\?#]/.test(path) || hasUnsafePath(path) ? '' : value;
}

module.exports = {
  safePublicUrl: safePublicUrl
};
