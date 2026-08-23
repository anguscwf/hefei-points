// 家长端 v2 端点白名单。页面只能通过这里选择端点和鉴权模式。
var IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,128}$/;
var CONSENT_OPERATIONS = { 'child-enrollment': true, 'child-consent': true };

function requireIdValue(value, field) {
  if (typeof value !== 'string' || !value || value.length > 128
      || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError((field || 'id') + ' is invalid');
  }
  return value;
}

function requireId(value, field) {
  return encodeURIComponent(requireIdValue(value, field));
}

function requireIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw new TypeError('Idempotency-Key is required');
  }
  return value;
}

function exactQuery(query, allowed) {
  if (query === undefined) return undefined;
  if (!query || Object.prototype.toString.call(query) !== '[object Object]') {
    throw new TypeError('query must be an object');
  }
  var result = {};
  Object.keys(query).forEach(function(key) {
    if (allowed.indexOf(key) < 0) throw new TypeError('unsupported query field: ' + key);
    if (query[key] !== undefined && query[key] !== null) result[key] = query[key];
  });
  return result;
}

function createGuardianApi(options) {
  var request = options && options.request;
  var createKey = options && options.createIdempotencyKey;
  if (typeof request !== 'function') throw new TypeError('guardian request is required');
  if (typeof createKey !== 'function') throw new TypeError('idempotency key factory is required');

  function read(path, query, auth) {
    return request({
      path: path,
      method: 'GET',
      query: query,
      auth: auth || 'adult'
    });
  }

  function write(method, path, body, idempotencyKey) {
    return request({
      path: path,
      method: method,
      body: body,
      auth: 'adult',
      idempotencyKey: requireIdempotencyKey(idempotencyKey)
    });
  }

  return {
    // 该清单端点是家长页唯一允许使用的儿童选择数据源。
    listChildren: function() {
      return read('/api/v2/children');
    },

    currentLegalTexts: function() {
      return read('/api/v2/legal-texts/current', undefined, 'public');
    },

    createReauth: function(body) {
      return request({
        path: '/api/v2/reauth-assertions',
        method: 'POST',
        body: body,
        auth: 'adult'
      });
    },

    enrollChild: function(body, idempotencyKey) {
      return write('POST', '/api/v2/child-enrollments', body, idempotencyKey);
    },

    getConsentOperation: function(operation, idempotencyKey) {
      if (!CONSENT_OPERATIONS[operation]) throw new TypeError('guardian consent operation is invalid');
      return request({
        path: '/api/v2/guardian-consent-operations/' + operation,
        method: 'GET',
        auth: 'adult',
        idempotencyKey: requireIdempotencyKey(idempotencyKey)
      });
    },

    listConsents: function(childId) {
      return read('/api/v2/children/' + requireId(childId, 'childId') + '/consents');
    },

    createConsent: function(childId, body, idempotencyKey) {
      return write(
        'POST',
        '/api/v2/children/' + requireId(childId, 'childId') + '/consents',
        body,
        idempotencyKey
      );
    },

    withdrawConsent: function(childId, body, idempotencyKey) {
      return write(
        'POST',
        '/api/v2/children/' + requireId(childId, 'childId') + '/consents/withdraw',
        body,
        idempotencyKey
      );
    },

    createPairing: function(body, idempotencyKey) {
      return write('POST', '/api/v2/device-pairings', body, idempotencyKey);
    },

    getPairing: function(pairingId) {
      return read('/api/v2/device-pairings/' + requireId(pairingId, 'pairingId'));
    },

    confirmPairing: function(pairingId, body, idempotencyKey) {
      return write(
        'POST',
        '/api/v2/device-pairings/' + requireId(pairingId, 'pairingId') + '/confirm',
        body,
        idempotencyKey
      );
    },

    listDevices: function() {
      return read('/api/v2/devices');
    },

    revokeDevice: function(deviceId, body, idempotencyKey) {
      return write('DELETE', '/api/v2/devices/' + requireId(deviceId, 'deviceId'), body, idempotencyKey);
    },

    revokeDeviceSession: function(sessionId, body, idempotencyKey) {
      return write(
        'DELETE',
        '/api/v2/device-sessions/' + requireId(sessionId, 'sessionId'),
        body,
        idempotencyKey
      );
    },

    taskSummary: function() {
      return read('/api/v2/family/tasks/summary');
    },

    listPointRequests: function(query) {
      return read(
        '/api/v2/point-requests',
        exactQuery(query, ['childId', 'status', 'limit', 'cursor'])
      );
    },

    getPointRequest: function(pointRequestId) {
      return read('/api/v2/point-requests/' + requireId(pointRequestId, 'pointRequestId'));
    },

    requestPointInfo: function(pointRequestId, body, idempotencyKey) {
      return write(
        'POST',
        '/api/v2/point-requests/' + requireId(pointRequestId, 'pointRequestId') + '/request-info',
        body,
        idempotencyKey
      );
    },

    approvePointRequest: function(pointRequestId, body, idempotencyKey) {
      return write(
        'POST',
        '/api/v2/point-requests/' + requireId(pointRequestId, 'pointRequestId') + '/approve',
        body,
        idempotencyKey
      );
    },

    rejectPointRequest: function(pointRequestId, body, idempotencyKey) {
      return write(
        'POST',
        '/api/v2/point-requests/' + requireId(pointRequestId, 'pointRequestId') + '/reject',
        body,
        idempotencyKey
      );
    },

    createDataRightsRequest: function(childId, body, idempotencyKey) {
      return write(
        'POST',
        '/api/v2/children/' + requireId(childId, 'childId') + '/data-rights-requests',
        body,
        idempotencyKey
      );
    },

    listDataRightsRequests: function(query) {
      return read(
        '/api/v2/data-rights-requests',
        exactQuery(query, ['childId', 'requestType', 'status', 'limit', 'cursor'])
      );
    },

    getDataRightsRequest: function(dataRightsRequestId) {
      return read(
        '/api/v2/data-rights-requests/' + requireId(dataRightsRequestId, 'dataRightsRequestId')
      );
    },

    exportChildData: function(childId, requestId) {
      return read(
        '/api/v2/children/' + requireId(childId, 'childId') + '/data-export',
        { requestId: requireIdValue(requestId, 'requestId') }
      );
    },

    createIdempotencyKey: function(scope) {
      return createKey(scope);
    }
  };
}

module.exports = { createGuardianApi: createGuardianApi };
