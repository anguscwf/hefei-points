const crypto = require('crypto');

const { ApiError } = require('../lib/api-error');
const repositories = require('../db/repositories');
const credentials = require('../lib/device-credentials');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const CURSOR_VERSION = 1;
const CURSOR_PACKET_BYTES = 69;
const CURSOR_TOKEN_LENGTH = 92;
const SQLITE_MAX_ROW_ID = 9223372036854775807n;
const SCOPE_FIELDS = new Set([
  'familyId', 'family_id',
  'childId', 'child_id',
  'kid', 'kidId', 'userId', 'user_id',
  'deviceId', 'device_id', 'deviceBindingId', 'device_binding_id',
  'sessionId', 'session_id', 'transactionId', 'transaction_id',
  'token', 'accessToken', 'refreshToken'
]);

function fail(status, code, message, field) {
  throw new ApiError({ status, code, message, field });
}

function objectKeys(value, { source, allowAbsent = true }) {
  if (value === undefined && allowAbsent) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(400, 'VALIDATION_ERROR', `${source}格式错误`);
  }
  return Object.keys(value);
}

function rejectScopeSelection(keys) {
  const field = keys.find(key => SCOPE_FIELDS.has(key));
  if (field) {
    fail(400, 'VALIDATION_ERROR', '儿童身份只能从设备会话确定', field);
  }
}

function validateEmptyBody(body) {
  const keys = objectKeys(body, { source: '请求体' });
  rejectScopeSelection(keys);
  if (keys.length) fail(400, 'VALIDATION_ERROR', '只读接口不接受请求体', keys[0]);
}

function validateQuery(query, allowed) {
  const keys = objectKeys(query, { source: '查询参数', allowAbsent: false });
  rejectScopeSelection(keys);
  const unknown = keys.find(key => !allowed.has(key));
  if (unknown) fail(400, 'VALIDATION_ERROR', '查询参数不受支持', unknown);
}

function deviceActor(actor) {
  if (!actor || actor.role !== 'device'
      || typeof actor.familyId !== 'string' || !actor.familyId
      || typeof actor.childId !== 'string' || !actor.childId
      || typeof actor.deviceBindingId !== 'string' || !actor.deviceBindingId
      || typeof actor.sessionId !== 'string' || !actor.sessionId
      || typeof actor.tokenFamilyId !== 'string' || !actor.tokenFamilyId
      || !Number.isSafeInteger(actor.rotationCounter) || actor.rotationCounter < 0) {
    fail(401, 'SESSION_REVOKED', '设备会话已失效');
  }
  return actor;
}

function repositoryInput(actor, now) {
  return {
    familyId: actor.familyId,
    childId: actor.childId,
    deviceBindingId: actor.deviceBindingId,
    sessionId: actor.sessionId,
    tokenFamilyId: actor.tokenFamilyId,
    rotationCounter: actor.rotationCounter,
    now: now.toISOString()
  };
}

function parseLimit(value) {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,2}$/.test(value)) {
    fail(400, 'VALIDATION_ERROR', 'limit 必须是 1 至 50 的整数', 'limit');
  }
  const limit = Number(value);
  if (limit > MAX_LIMIT) {
    fail(400, 'VALIDATION_ERROR', 'limit 必须是 1 至 50 的整数', 'limit');
  }
  return limit;
}

function cursorKey() {
  return Buffer.from(credentials.hmac(
    'child-self-cursor-aead-key',
    `v${CURSOR_VERSION}`
  ), 'hex');
}

function cursorAad(actor, version) {
  return Buffer.concat([
    Buffer.from([version]),
    Buffer.from(JSON.stringify([
      `tangguan-child-self-cursor-v${version}`,
      actor.familyId,
      actor.childId,
      actor.deviceBindingId
    ]), 'utf8')
  ]);
}

function decodeCursor(value, actor) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length !== CURSOR_TOKEN_LENGTH
      || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail(400, 'VALIDATION_ERROR', '分页游标无效', 'cursor');
  }
  const packet = Buffer.from(value, 'base64url');
  if (packet.toString('base64url') !== value
      || packet.length !== CURSOR_PACKET_BYTES
      || packet[0] !== CURSOR_VERSION) {
    fail(400, 'VALIDATION_ERROR', '分页游标无效', 'cursor');
  }
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      cursorKey(),
      packet.subarray(1, 13)
    );
    decipher.setAAD(cursorAad(actor, packet[0]));
    decipher.setAuthTag(packet.subarray(13, 29));
    plaintext = Buffer.concat([
      decipher.update(packet.subarray(29)),
      decipher.final()
    ]);
  } catch (_) {
    fail(400, 'VALIDATION_ERROR', '分页游标无效', 'cursor');
  }
  if (plaintext.length !== 40) {
    fail(400, 'VALIDATION_ERROR', '分页游标无效', 'cursor');
  }
  const cursorRowId = plaintext.readBigUInt64BE(0);
  if (cursorRowId === 0n || cursorRowId > SQLITE_MAX_ROW_ID) {
    fail(400, 'VALIDATION_ERROR', '分页游标无效', 'cursor');
  }
  return {
    cursorRowId: cursorRowId.toString(),
    transactionIdHash: plaintext.subarray(8).toString('hex')
  };
}

function encodeCursor(item, actor) {
  const cursorRowId = BigInt(item.cursorRowId);
  if (cursorRowId < 1n || cursorRowId > SQLITE_MAX_ROW_ID) {
    throw new TypeError('transaction cursor rowid is invalid');
  }
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cursorKey(), nonce);
  cipher.setAAD(cursorAad(actor, CURSOR_VERSION));
  const plaintext = Buffer.alloc(40);
  plaintext.writeBigUInt64BE(cursorRowId, 0);
  Buffer.from(credentials.sha256(item.transaction.id), 'hex').copy(plaintext, 8);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([
    Buffer.from([CURSOR_VERSION]),
    nonce,
    cipher.getAuthTag(),
    encrypted
  ]).toString('base64url');
}

function summary({ actor, query = {}, body, now = new Date() } = {}) {
  validateQuery(query, new Set());
  validateEmptyBody(body);
  const context = deviceActor(actor);
  const child = repositories.childSelf.authorizedChild(repositoryInput(context, now));
  if (!child) fail(401, 'SESSION_REVOKED', '设备会话已失效');
  if (!child.hasPointAccount) {
    fail(409, 'CHILD_DATA_INCOMPLETE', '儿童积分账户状态异常');
  }
  return {
    success: true,
    child: { id: child.childId, name: child.childName },
    points: { balance: child.balance }
  };
}

function transactions({ actor, query = {}, body, now = new Date() } = {}) {
  validateQuery(query, new Set(['limit', 'cursor']));
  validateEmptyBody(body);
  const context = deviceActor(actor);
  const limit = parseLimit(query.limit);
  const cursor = decodeCursor(query.cursor, context);
  const result = repositories.childSelf.listTransactions({
    ...repositoryInput(context, now),
    cursorRowId: cursor && cursor.cursorRowId,
    cursorTransactionIdHash: cursor && cursor.transactionIdHash,
    limit
  });
  if (!result.authorized) fail(401, 'SESSION_REVOKED', '设备会话已失效');
  if (!result.accountComplete) {
    fail(409, 'CHILD_DATA_INCOMPLETE', '儿童积分账户状态异常');
  }
  if (!result.cursorValid) fail(400, 'VALIDATION_ERROR', '分页游标无效', 'cursor');

  const hasMore = result.rows.length > limit;
  const visible = hasMore ? result.rows.slice(0, limit) : result.rows;
  return {
    success: true,
    transactions: visible.map(item => item.transaction),
    page: {
      limit,
      hasMore,
      nextCursor: hasMore
        ? encodeCursor(visible[visible.length - 1], context)
        : null
    }
  };
}

module.exports = {
  summary,
  transactions
};
