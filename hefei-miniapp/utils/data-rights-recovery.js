// 仅保存数据权利请求的非秘密恢复作用域与幂等句柄，不保存请求正文或身份凭据。
var STORAGE_KEY = 'hefei_guardian_data_rights_recovery_v1';
var MAX_RECORDS = 32;
var ADULT_ROLES = { admin: true, parent: true };
var REQUEST_TYPES = {
  access: true,
  export: true,
  correct: true,
  delete: true,
  terminate: true
};
var IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,128}$/;
var CHILD_ID = /^[A-Za-z0-9_-]{2,64}$/;
var CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
var RECORD_KEYS = [
  'actorId', 'childId', 'createdAt', 'familyId',
  'idempotencyKey', 'requestType', 'version'
];

function exactRecordKeys(record) {
  return Object.keys(record).sort().join('|') === RECORD_KEYS.join('|');
}

function validScopeId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64
    && value === value.trim() && !CONTROL_CHARACTERS.test(value);
}

function validUser(user) {
  return !!user && ADULT_ROLES[user.role] === true
    && validScopeId(user.id) && validScopeId(user.familyId);
}

function validRecord(record) {
  return !!record && Object.prototype.toString.call(record) === '[object Object]'
    && exactRecordKeys(record)
    && record.version === 1
    && validScopeId(record.actorId) && validScopeId(record.familyId)
    && typeof record.childId === 'string' && CHILD_ID.test(record.childId)
    && REQUEST_TYPES[record.requestType] === true
    && typeof record.idempotencyKey === 'string' && IDEMPOTENCY_KEY.test(record.idempotencyKey)
    && Number.isFinite(record.createdAt) && record.createdAt > 0;
}

function publicRecord(record) {
  return record ? {
    childId: record.childId,
    requestType: record.requestType,
    idempotencyKey: record.idempotencyKey,
    createdAt: record.createdAt
  } : null;
}

function createRecoveryStore(options) {
  var storage = options && options.storage;
  var getUser = options && options.getUser;
  if (!storage || typeof getUser !== 'function') {
    throw new TypeError('data rights recovery storage is required');
  }

  function records() {
    if (typeof storage.getStorageSync !== 'function') {
      throw new Error('data rights recovery storage is unavailable');
    }
    try {
      var value = storage.getStorageSync(STORAGE_KEY);
      if (value === undefined || value === null || value === '') return [];
      var parsed = typeof value === 'string' ? JSON.parse(value) : value;
      if (!Array.isArray(parsed) || parsed.length > MAX_RECORDS
          || parsed.some(function(item) { return !validRecord(item); })) {
        throw new Error('data rights recovery storage is corrupt');
      }
      var scopes = {};
      parsed.forEach(function(item) {
        var scope = item.actorId + '\n' + item.familyId;
        if (scopes[scope]) throw new Error('data rights recovery storage has duplicate scope');
        scopes[scope] = true;
      });
      return parsed.slice();
    } catch (error) {
      throw new Error('data rights recovery storage cannot be read');
    }
  }

  function save(values) {
    if (typeof storage.setStorageSync !== 'function') {
      throw new Error('data rights recovery storage is unavailable');
    }
    if (!Array.isArray(values) || values.length > MAX_RECORDS) {
      throw new Error('data rights recovery storage is full');
    }
    try {
      storage.setStorageSync(STORAGE_KEY, JSON.stringify(values));
    } catch (error) {
      throw new Error('data rights recovery storage cannot be written');
    }
  }

  function current() {
    var user = getUser();
    if (!validUser(user)) return null;
    var record = records().find(function(item) {
      return item.actorId === user.id && item.familyId === user.familyId;
    });
    return publicRecord(record);
  }

  function begin(childId, requestType, idempotencyKey) {
    var user = getUser();
    if (!validUser(user) || typeof childId !== 'string' || !CHILD_ID.test(childId)
        || REQUEST_TYPES[requestType] !== true
        || typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new TypeError('data rights recovery marker is invalid');
    }
    var values = records();
    var existing = values.find(function(item) {
      return item.actorId === user.id && item.familyId === user.familyId;
    });
    if (existing) {
      if (existing.childId === childId && existing.requestType === requestType
          && existing.idempotencyKey === idempotencyKey) {
        return publicRecord(existing);
      }
      throw new Error('data rights recovery is already pending');
    }
    if (values.length >= MAX_RECORDS) {
      throw new Error('data rights recovery storage is full');
    }
    values.push({
      version: 1,
      actorId: user.id,
      familyId: user.familyId,
      childId: childId,
      requestType: requestType,
      idempotencyKey: idempotencyKey,
      createdAt: Date.now()
    });
    save(values);
    var saved = current();
    if (!saved || saved.childId !== childId || saved.requestType !== requestType
        || saved.idempotencyKey !== idempotencyKey) {
      throw new Error('data rights recovery marker verification failed');
    }
    return saved;
  }

  function clearScope(actorId, familyId, expectedKey) {
    if (typeof expectedKey !== 'string' || !IDEMPOTENCY_KEY.test(expectedKey)) {
      throw new TypeError('data rights recovery key is invalid');
    }
    if (!validScopeId(actorId) || !validScopeId(familyId)) {
      throw new TypeError('data rights recovery scope is invalid');
    }
    var removed = false;
    var scopedRecord = null;
    var values = records().filter(function(item) {
      if (item.actorId === actorId && item.familyId === familyId) scopedRecord = item;
      var matches = item.actorId === actorId && item.familyId === familyId
        && item.idempotencyKey === expectedKey;
      if (matches) removed = true;
      return !matches;
    });
    if (!scopedRecord) return true;
    if (!removed) return false;
    save(values);
    var remaining = records().find(function(item) {
      return item.actorId === actorId && item.familyId === familyId;
    });
    if (remaining) {
      throw new Error('data rights recovery marker clear verification failed');
    }
    return true;
  }

  function clear(expectedKey) {
    var user = getUser();
    if (!validUser(user)) return false;
    return clearScope(user.id, user.familyId, expectedKey);
  }

  return { current: current, begin: begin, clear: clear, clearScope: clearScope };
}

module.exports = { createRecoveryStore: createRecoveryStore };
