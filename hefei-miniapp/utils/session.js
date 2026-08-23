// 微信小程序成人会话的唯一持久化入口。
// 缓存用户只用于界面展示；服务端始终重新验证 Token、角色和家庭作用域。
var TOKEN_KEY = 'hefei_token';
var USER_KEY = 'hefei_user';
var TOKEN_PATTERN = /^hefei\.[\x21-\x7e]+$/;
var ADULT_ROLES = { admin: true, parent: true };
var KNOWN_ROLES = { admin: true, parent: true, child: true };

function isPlainObject(value) {
  if (!value || Object.prototype.toString.call(value) !== '[object Object]') return false;
  var prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedText(value, maxLength) {
  if (typeof value !== 'string') return '';
  var normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return '';
  return normalized;
}

function normalizeToken(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 512) return '';
  if (value !== value.trim() || !TOKEN_PATTERN.test(value)) return '';
  return value;
}

function sanitizeUser(value) {
  if (!isPlainObject(value)) return null;
  var id = boundedText(value.id, 64);
  var name = boundedText(value.name, 100);
  var role = boundedText(value.role, 16);
  var familyId = boundedText(value.familyId, 64);
  if (!id || !name || !familyId || !KNOWN_ROLES[role]) return null;
  return { id: id, name: name, role: role, familyId: familyId };
}

function createSessionStore(options) {
  var storage = options && options.storage;
  if (!storage
      || typeof storage.getStorageSync !== 'function'
      || typeof storage.setStorageSync !== 'function'
      || typeof storage.removeStorageSync !== 'function') {
    throw new TypeError('session storage is required');
  }

  function storageEmpty(value) {
    return value === undefined || value === null || value === '';
  }

  function verifyCleared() {
    return storageEmpty(storage.getStorageSync(TOKEN_KEY))
      && storageEmpty(storage.getStorageSync(USER_KEY));
  }

  function clear() {
    try {
      storage.removeStorageSync(TOKEN_KEY);
      storage.removeStorageSync(USER_KEY);
      if (!verifyCleared()) {
        // 某些宿主可能静默忽略 remove；用空值覆盖后再次读回验证。
        storage.setStorageSync(TOKEN_KEY, '');
        storage.setStorageSync(USER_KEY, '');
      }
      if (!verifyCleared()) throw new Error('session storage clear verification failed');
    } catch (error) {
      throw new Error('session storage could not be cleared');
    }
    return { token: '', user: null };
  }

  function restore() {
    var rawToken;
    var rawUser;
    try {
      rawToken = storage.getStorageSync(TOKEN_KEY);
      rawUser = storage.getStorageSync(USER_KEY);
    } catch (error) {
      return clear();
    }
    if (!rawToken && !rawUser) return { token: '', user: null };

    var parsedUser = rawUser;
    if (typeof rawUser === 'string') {
      try {
        parsedUser = JSON.parse(rawUser);
      } catch (error) {
        return clear();
      }
    }
    var token = normalizeToken(rawToken);
    var user = sanitizeUser(parsedUser);
    if (!token || !user) return clear();
    return { token: token, user: user };
  }

  function commit(tokenValue, userValue) {
    var token = normalizeToken(tokenValue);
    var user = sanitizeUser(userValue);
    if (!token || !user) throw new TypeError('invalid session');
    try {
      // 先写入并验证认证墓碑，再更新用户。这样从会话 A 切到 B 的任一
      // 中间失败都不会留下 userB + tokenA 的跨家庭组合。
      storage.setStorageSync(TOKEN_KEY, '');
      if (!storageEmpty(storage.getStorageSync(TOKEN_KEY))) {
        throw new Error('session token tombstone verification failed');
      }
      storage.setStorageSync(USER_KEY, JSON.stringify(user));
      var stagedUser = storage.getStorageSync(USER_KEY);
      var parsedStagedUser = typeof stagedUser === 'string'
        ? JSON.parse(stagedUser) : stagedUser;
      var verifiedStagedUser = sanitizeUser(parsedStagedUser);
      if (!verifiedStagedUser
          || verifiedStagedUser.id !== user.id || verifiedStagedUser.name !== user.name
          || verifiedStagedUser.role !== user.role
          || verifiedStagedUser.familyId !== user.familyId) {
        throw new Error('session user staging verification failed');
      }
      // 有效 Token 始终最后写入，并对最终二元组做整体验证。
      storage.setStorageSync(TOKEN_KEY, token);
      var persistedToken = storage.getStorageSync(TOKEN_KEY);
      var persistedUser = storage.getStorageSync(USER_KEY);
      var parsedUser = typeof persistedUser === 'string'
        ? JSON.parse(persistedUser) : persistedUser;
      var verifiedUser = sanitizeUser(parsedUser);
      if (persistedToken !== token || !verifiedUser
          || verifiedUser.id !== user.id || verifiedUser.name !== user.name
          || verifiedUser.role !== user.role || verifiedUser.familyId !== user.familyId) {
        throw new Error('session storage commit verification failed');
      }
    } catch (error) {
      try { clear(); } catch (clearError) {
        throw new Error('session storage is unavailable');
      }
      throw new Error('session storage commit failed');
    }
    return { token: token, user: user };
  }

  function getAdultBearer(session) {
    var candidate = session || restore();
    var token = normalizeToken(candidate && candidate.token);
    var user = sanitizeUser(candidate && candidate.user);
    return token && user && ADULT_ROLES[user.role] ? token : '';
  }

  return {
    restore: restore,
    commit: commit,
    clear: clear,
    getAdultBearer: getAdultBearer
  };
}

module.exports = {
  TOKEN_KEY: TOKEN_KEY,
  USER_KEY: USER_KEY,
  createSessionStore: createSessionStore,
  normalizeToken: normalizeToken,
  sanitizeUser: sanitizeUser
};
