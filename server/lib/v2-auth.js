const { verifyToken } = require('./token');
const { ApiError } = require('./api-error');
const features = require('../config/features');
const repositories = require('../db/repositories');
const deviceCredentials = require('./device-credentials');

function bearerToken(req) {
  const authorization = req && req.headers && req.headers.authorization;
  if (typeof authorization !== 'string') return '';
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match ? match[1] : '';
}

function requireAdultV2(req) {
  const user = verifyToken(bearerToken(req));
  if (!user) {
    throw new ApiError({
      status: 401,
      code: 'AUTH_REQUIRED',
      message: '请先登录'
    });
  }
  if (user.role !== 'admin' && user.role !== 'parent') {
    throw new ApiError({
      status: 403,
      code: 'FORBIDDEN_SCOPE',
      message: '当前账号无权执行此操作'
    });
  }
  return user;
}

function requireDeviceGate() {
  if (!features.isHarmonyChildEnabled() || !features.isDevicePairingEnabled()) {
    throw new ApiError({
      status: 403,
      code: 'FEATURE_DISABLED',
      message: '儿童设备能力当前未开放'
    });
  }
}

function deviceAccessContext(rawToken, now = new Date()) {
  if (!deviceCredentials.ACCESS_TOKEN.test(String(rawToken || ''))) return null;
  const session = repositories.deviceSessions.findSessionByAccessHash({
    accessTokenHash: deviceCredentials.digestCredential(rawToken)
  });
  if (!session) return null;
  if (session.status !== 'active') return { revoked: true };
  if (session.accessExpiresAt <= now.toISOString()) return { expired: true };
  const context = repositories.deviceSessions.activeDeviceContext({ sessionId: session.id });
  if (!context || context.bindingStatus !== 'active' || context.privacyStatus !== 'active') {
    return { revoked: true };
  }
  const consent = repositories.guardianConsents.findActiveConsent({
    familyId: session.familyId,
    childId: session.childId,
    guardianId: context.createdByGuardianId
  });
  if (!consent) return { revoked: true };
  return {
    role: 'device',
    familyId: session.familyId,
    childId: session.childId,
    deviceBindingId: session.deviceBindingId,
    sessionId: session.id,
    tokenFamilyId: session.tokenFamilyId,
    rotationCounter: session.rotationCounter
  };
}

function requireDeviceV2(req, now = new Date()) {
  requireDeviceGate();
  const rawToken = bearerToken(req);
  if (!rawToken || !deviceCredentials.ACCESS_TOKEN.test(rawToken)) {
    throw new ApiError({ status: 401, code: 'AUTH_REQUIRED', message: '请先完成设备认证' });
  }
  const context = deviceAccessContext(rawToken, now);
  if (!context || context.revoked) {
    throw new ApiError({ status: 401, code: 'SESSION_REVOKED', message: '设备会话已失效' });
  }
  if (context.expired) {
    throw new ApiError({ status: 401, code: 'ACCESS_TOKEN_EXPIRED', message: '设备访问凭据已过期' });
  }
  return context;
}

function requireCredentialBearer(req, pattern, message) {
  const rawToken = bearerToken(req);
  if (!rawToken || !pattern.test(rawToken)) {
    throw new ApiError({ status: 401, code: 'AUTH_REQUIRED', message });
  }
  return rawToken;
}

function requireRefreshV2(req) {
  return requireCredentialBearer(req, deviceCredentials.REFRESH_TOKEN, '请提供设备刷新凭据');
}

function requirePairingClaimV2(req) {
  return requireCredentialBearer(req, deviceCredentials.CLAIM_TOKEN, '请提供设备配对申领凭据');
}

module.exports = {
  bearerToken,
  requireAdultV2,
  requireDeviceV2,
  requireRefreshV2,
  requirePairingClaimV2,
  deviceAccessContext
};
