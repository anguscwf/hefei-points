// Legacy transport still serves existing pages, but it may only append a strict
// relative /api path to the immutable runtime origin.
function decodedPathIsSafe(pathname) {
  var candidate = pathname;
  for (var pass = 0; pass < 4; pass += 1) {
    if (!/^\/api(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*$/.test(candidate)
        || candidate.indexOf('//') >= 0
        || /[\u0000-\u0020\u007f\\?#]/.test(candidate)) return false;
    var segments = candidate.split('/');
    if (segments.some(function(segment) { return segment === '.' || segment === '..'; })) {
      return false;
    }
    var decoded;
    try {
      decoded = decodeURIComponent(candidate);
    } catch (error) {
      return false;
    }
    if (decoded === candidate) return true;
    candidate = decoded;
  }
  return false;
}

function normalize(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()
      || value.length > 2048 || /[\u0000-\u0020\u007f\\#]/.test(value)) return '';
  var queryIndex = value.indexOf('?');
  if (queryIndex >= 0 && value.indexOf('?', queryIndex + 1) >= 0) return '';
  var pathname = queryIndex < 0 ? value : value.slice(0, queryIndex);
  var query = queryIndex < 0 ? '' : value.slice(queryIndex + 1);
  if (!decodedPathIsSafe(pathname)) return '';
  if (queryIndex >= 0 && (!query || query.length > 4096
      || /[\u0000-\u0020\u007f\\#]/.test(query))) return '';
  return value;
}

module.exports = {
  normalize: normalize
};
