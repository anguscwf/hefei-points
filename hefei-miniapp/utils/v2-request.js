// v2 传输层：固定 HTTPS 源、严格相对路径、稳定结果和成人会话失效联动。
var ALLOWED_METHODS = { GET: true, POST: true, PATCH: true, DELETE: true };
var ALLOWED_OPTION_KEYS = {
  path: true,
  method: true,
  query: true,
  body: true,
  auth: true,
  idempotencyKey: true,
  timeout: true
};
var IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,128}$/;
var QUERY_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
var FORBIDDEN_QUERY_KEYS = { constructor: true, prototype: true, __proto__: true };

function isPlainObject(value) {
  if (!value || Object.prototype.toString.call(value) !== '[object Object]') return false;
  var prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clientError(code, message, details) {
  var extra = details || {};
  var result = {
    ok: false,
    success: false,
    status: Number.isInteger(extra.status) ? extra.status : 0,
    code: code,
    message: message,
    requestId: extra.requestId || '',
    headers: extra.headers || {},
    retryable: !!extra.retryable,
    outcomeUnknown: !!extra.outcomeUnknown
  };
  if (extra.field) result.field = extra.field;
  if (extra.data !== undefined) result.data = extra.data;
  return result;
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value !== value.trim()) return '';
  var normalized = value.replace(/\/$/, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(normalized)) return '';
  return normalized;
}

function normalizePath(value) {
  if (typeof value !== 'string' || value !== value.trim()) return '';
  if (value.indexOf('?') >= 0 || value.indexOf('#') >= 0 || value.indexOf('\\') >= 0) return '';
  var decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch (error) {
    return '';
  }
  if (decoded.indexOf('//') >= 0 || decoded.indexOf('\\') >= 0) return '';
  if (!/^\/api\/v2(?:\/[A-Za-z0-9._~-]+)+$/.test(decoded)) return '';
  var segments = decoded.split('/');
  if (segments.some(function(segment) { return segment === '.' || segment === '..'; })) return '';
  return value;
}

function buildQuery(query) {
  if (query === undefined) return { ok: true, value: '' };
  if (!isPlainObject(query)) return { ok: false, field: 'query' };
  var parts = [];
  var keys = Object.keys(query).sort();
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var value = query[key];
    if (!QUERY_KEY.test(key) || FORBIDDEN_QUERY_KEYS[key]) return { ok: false, field: key };
    if (value === undefined || value === null) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) return { ok: false, field: key };
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return { ok: false, field: key };
    }
    var textValue = String(value);
    if (textValue.length > 2048) return { ok: false, field: key };
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(textValue));
  }
  var encoded = parts.join('&');
  if (encoded.length > 4096) return { ok: false, field: 'query' };
  return { ok: true, value: encoded ? '?' + encoded : '' };
}

function normalizeHeaders(value) {
  if (!isPlainObject(value)) return {};
  var normalized = {};
  Object.keys(value).forEach(function(key) {
    normalized[String(key).toLowerCase()] = value[key];
  });
  return normalized;
}

function responseRequestId(payload, headers) {
  var candidate = payload && payload.requestId;
  if (typeof candidate !== 'string' || !candidate || candidate.length > 128) {
    candidate = headers['x-request-id'];
  }
  return typeof candidate === 'string' && candidate.length <= 128 ? candidate : '';
}

function invalidResponse(status, headers, payload, method) {
  return clientError('INVALID_RESPONSE', '服务器响应格式错误', {
    status: status,
    headers: headers,
    requestId: responseRequestId(payload, headers),
    data: payload,
    retryable: method === 'GET' && status >= 500,
    outcomeUnknown: method !== 'GET'
  });
}

function normalizeResponse(res, method) {
  var status = res && Number.isInteger(res.statusCode) ? res.statusCode : 0;
  var headers = normalizeHeaders(res && res.header);
  var payload = res && res.data;
  if (!isPlainObject(payload) || typeof payload.success !== 'boolean') {
    return invalidResponse(status, headers, payload, method);
  }

  var requestId = responseRequestId(payload, headers);
  var httpSuccess = status >= 200 && status < 300;
  if (httpSuccess && payload.success === true) {
    return {
      ok: true,
      success: true,
      status: status,
      code: typeof payload.code === 'string' ? payload.code : '',
      requestId: requestId,
      headers: headers,
      retryable: false,
      outcomeUnknown: false,
      data: payload
    };
  }
  if (payload.success !== false) return invalidResponse(status, headers, payload, method);

  var retryableStatus = status === 408 || status === 425 || status === 429
    || status === 502 || status === 503 || status === 504;
  var result = clientError(
    typeof payload.code === 'string' && payload.code ? payload.code : 'HTTP_ERROR',
    typeof payload.message === 'string' && payload.message ? payload.message : '请求处理失败',
    {
      status: status,
      headers: headers,
      requestId: requestId,
      field: typeof payload.field === 'string' ? payload.field : '',
      data: payload,
      retryable: method === 'GET' && retryableStatus,
      outcomeUnknown: method !== 'GET'
        && (status === 408 || status === 425 || status === 429 || status >= 500)
    }
  );
  return result;
}

function normalizeRequestOptions(options) {
  if (!isPlainObject(options)) return { error: clientError('CLIENT_REQUEST_INVALID', '请求参数格式错误') };
  var unknown = Object.keys(options).find(function(key) { return !ALLOWED_OPTION_KEYS[key]; });
  if (unknown) {
    return { error: clientError('CLIENT_REQUEST_INVALID', '请求参数不受支持', { field: unknown }) };
  }
  var path = normalizePath(options.path);
  if (!path) return { error: clientError('CLIENT_REQUEST_INVALID', 'v2 请求路径无效', { field: 'path' }) };

  var method = String(options.method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS[method]) {
    return { error: clientError('CLIENT_REQUEST_INVALID', '请求方法不受支持', { field: 'method' }) };
  }
  var auth = options.auth === undefined ? 'adult' : options.auth;
  if (auth !== 'adult' && auth !== 'public') {
    return { error: clientError('CLIENT_REQUEST_INVALID', '请求鉴权类型无效', { field: 'auth' }) };
  }
  if (method === 'GET' && options.body !== undefined) {
    return { error: clientError('CLIENT_REQUEST_INVALID', 'GET 请求不能携带请求体', { field: 'body' }) };
  }
  if (options.body !== undefined && !isPlainObject(options.body)) {
    return { error: clientError('CLIENT_REQUEST_INVALID', '请求体必须是对象', { field: 'body' }) };
  }
  if (options.idempotencyKey !== undefined
      && (typeof options.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(options.idempotencyKey))) {
    return { error: clientError('CLIENT_REQUEST_INVALID', 'Idempotency-Key 格式错误', { field: 'idempotencyKey' }) };
  }
  var timeout = options.timeout === undefined ? 15000 : options.timeout;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 30000) {
    return { error: clientError('CLIENT_REQUEST_INVALID', '请求超时时间无效', { field: 'timeout' }) };
  }
  var query = buildQuery(options.query);
  if (!query.ok) {
    return { error: clientError('CLIENT_REQUEST_INVALID', '查询参数无效', { field: query.field }) };
  }
  return {
    value: {
      path: path,
      method: method,
      auth: auth,
      body: options.body,
      idempotencyKey: options.idempotencyKey,
      timeout: timeout,
      query: query.value
    }
  };
}

function randomFailure(message) {
  var error = new Error(message || '无法生成安全随机数');
  error.code = 'CSPRNG_UNAVAILABLE';
  return error;
}

function createIdempotencyKey(wxApi, scope) {
  var keyScope = scope === undefined ? 'miniapp' : scope;
  if (typeof keyScope !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(keyScope)) {
    return Promise.reject(randomFailure('幂等键作用域无效'));
  }
  if (!wxApi || typeof wxApi.getRandomValues !== 'function') {
    return Promise.reject(randomFailure('当前环境不支持密码学安全随机数'));
  }
  return new Promise(function(resolve, reject) {
    try {
      wxApi.getRandomValues({
        length: 16,
        success: function(res) {
          var buffer = res && res.randomValues;
          if (!buffer || buffer.byteLength !== 16) {
            reject(randomFailure('安全随机数长度错误'));
            return;
          }
          var bytes;
          try {
            bytes = new Uint8Array(buffer);
          } catch (error) {
            reject(randomFailure('安全随机数格式错误'));
            return;
          }
          var hex = '';
          for (var i = 0; i < bytes.length; i++) hex += ('0' + bytes[i].toString(16)).slice(-2);
          resolve(keyScope + ':' + hex);
        },
        fail: function() {
          reject(randomFailure());
        }
      });
    } catch (error) {
      reject(randomFailure());
    }
  });
}

function createV2Client(options) {
  var wxApi = options && options.wxApi;
  var baseUrl = normalizeBaseUrl(options && options.baseUrl);
  var getAdultToken = options && options.getAdultToken;
  var onAuthInvalid = options && options.onAuthInvalid;
  if (!wxApi || typeof wxApi.request !== 'function') throw new TypeError('wx.request is required');
  if (!baseUrl) throw new TypeError('a fixed HTTPS API base is required');
  if (typeof getAdultToken !== 'function') throw new TypeError('getAdultToken is required');

  function request(requestOptions) {
    var normalized = normalizeRequestOptions(requestOptions);
    if (normalized.error) return Promise.resolve(normalized.error);
    var input = normalized.value;
    var tokenSnapshot = '';
    var headers = { Accept: 'application/json' };
    if (input.auth === 'adult') {
      tokenSnapshot = getAdultToken() || '';
      if (!tokenSnapshot) return Promise.resolve(clientError('AUTH_REQUIRED', '请先使用成人账号登录'));
      headers.Authorization = 'Bearer ' + tokenSnapshot;
    }
    if (input.body !== undefined) headers['Content-Type'] = 'application/json';
    if (input.idempotencyKey !== undefined) headers['Idempotency-Key'] = input.idempotencyKey;

    return new Promise(function(resolve) {
      var settled = false;
      function finish(result) {
        if (settled) return;
        settled = true;
        resolve(result);
      }
      try {
        wxApi.request({
          url: baseUrl + input.path + input.query,
          method: input.method,
          data: input.body,
          header: headers,
          timeout: input.timeout,
          success: function(res) {
            var result = normalizeResponse(res, input.method);
            if (input.auth === 'adult'
                && result.status === 401
                && result.code === 'AUTH_REQUIRED'
                && tokenSnapshot
                && typeof onAuthInvalid === 'function') {
              onAuthInvalid(tokenSnapshot, result);
            }
            finish(result);
          },
          fail: function(error) {
            var timedOut = error && typeof error.errMsg === 'string' && /timeout/i.test(error.errMsg);
            finish(clientError(
              timedOut ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
              timedOut ? '请求超时，请稍后重试' : '网络连接失败，请稍后重试',
              {
                retryable: input.method === 'GET',
                outcomeUnknown: input.method !== 'GET'
              }
            ));
          }
        });
      } catch (error) {
        finish(clientError('NETWORK_ERROR', '网络请求无法发起', {
          retryable: input.method === 'GET',
          outcomeUnknown: input.method !== 'GET'
        }));
      }
    });
  }

  return {
    request: request,
    createIdempotencyKey: function(scope) { return createIdempotencyKey(wxApi, scope); }
  };
}

module.exports = {
  createV2Client: createV2Client,
  createIdempotencyKey: createIdempotencyKey,
  normalizePath: normalizePath
};
