const { verifyToken } = require('./token');
const { ApiError } = require('./api-error');

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

module.exports = { requireAdultV2 };
