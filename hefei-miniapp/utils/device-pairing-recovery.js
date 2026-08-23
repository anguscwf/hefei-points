// 仅保存可重放“创建配对”的作用域与幂等句柄；不保存短码、challenge 或设备凭据。
var STORAGE_KEY = 'hefei_guardian_pairing_recovery_v1';
var MAX_RECORDS = 32;
var IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,128}$/;

function validUser(user) {
  return !!user && user.role !== 'child'
    && typeof user.id === 'string' && user.id
    && typeof user.familyId === 'string' && user.familyId;
}

function validRecord(record) {
  return !!record && record.version === 1
    && typeof record.actorId === 'string' && record.actorId
    && typeof record.familyId === 'string' && record.familyId
    && typeof record.childId === 'string' && record.childId
    && typeof record.idempotencyKey === 'string' && IDEMPOTENCY_KEY.test(record.idempotencyKey)
    && Number.isFinite(record.createdAt) && record.createdAt > 0;
}

function createRecoveryStore(options) {
  var storage = options && options.storage;
  var getUser = options && options.getUser;
  if (!storage || typeof getUser !== 'function') throw new TypeError('pairing recovery storage is required');

  function records() {
    if (typeof storage.getStorageSync !== 'function') throw new Error('pairing recovery storage is unavailable');
    try {
      var value = storage.getStorageSync(STORAGE_KEY);
      if (value === undefined || value === null || value === '') return [];
      var parsed = typeof value === 'string' ? JSON.parse(value) : value;
      if (!Array.isArray(parsed) || parsed.length > MAX_RECORDS
          || parsed.some(function(item) { return !validRecord(item); })) {
        throw new Error('pairing recovery storage is corrupt');
      }
      return parsed.slice();
    } catch (error) {
      throw new Error('pairing recovery storage cannot be read');
    }
  }

  function save(values) {
    if (typeof storage.setStorageSync !== 'function') throw new Error('pairing recovery storage is unavailable');
    if (values.length > MAX_RECORDS) throw new Error('pairing recovery storage is full');
    storage.setStorageSync(STORAGE_KEY, JSON.stringify(values));
  }

  function current() {
    var user = getUser();
    if (!validUser(user)) return null;
    var record = records().find(function(item) {
      return item.actorId === user.id && item.familyId === user.familyId;
    });
    return record ? {
      childId: record.childId,
      idempotencyKey: record.idempotencyKey,
      createdAt: record.createdAt
    } : null;
  }

  function begin(childId, idempotencyKey) {
    var user = getUser();
    if (!validUser(user) || typeof childId !== 'string' || !childId
        || typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new TypeError('pairing recovery marker is invalid');
    }
    var next = records().filter(function(item) {
      return item.actorId !== user.id || item.familyId !== user.familyId;
    });
    if (next.length >= MAX_RECORDS) throw new Error('pairing recovery storage is full');
    next.push({
      version: 1,
      actorId: user.id,
      familyId: user.familyId,
      childId: childId,
      idempotencyKey: idempotencyKey,
      createdAt: Date.now()
    });
    save(next);
    var saved = current();
    if (!saved || saved.childId !== childId || saved.idempotencyKey !== idempotencyKey) {
      throw new Error('pairing recovery marker verification failed');
    }
    return saved;
  }

  function clear(expectedKey) {
    var user = getUser();
    if (!validUser(user)) return false;
    var removed = false;
    var next = records().filter(function(item) {
      var sameScope = item.actorId === user.id && item.familyId === user.familyId;
      var sameKey = expectedKey === undefined || item.idempotencyKey === expectedKey;
      if (sameScope && sameKey) {
        removed = true;
        return false;
      }
      return true;
    });
    if (removed) save(next);
    return removed;
  }

  return { current: current, begin: begin, clear: clear };
}

module.exports = { createRecoveryStore: createRecoveryStore };
