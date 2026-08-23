class ApiError extends Error {
  constructor({ status = 400, code, message, field } = {}) {
    super(typeof message === 'string' && message ? message : '请求处理失败');
    this.name = 'ApiError';
    this.status = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
    this.code = typeof code === 'string' && code ? code : 'REQUEST_FAILED';
    if (typeof field === 'string' && field) this.field = field;
  }
}

function sendApiError(req, res, error) {
  const isKnown = error instanceof ApiError;
  const status = isKnown ? error.status : 500;
  const body = {
    success: false,
    code: isKnown ? error.code : 'INTERNAL_ERROR',
    message: isKnown ? error.message : '服务器内部错误'
  };
  if (req && typeof req.requestId === 'string' && req.requestId) body.requestId = req.requestId;
  if (isKnown && typeof error.field === 'string' && error.field) body.field = error.field;
  return res.status(status).json(body);
}

module.exports = { ApiError, sendApiError };
