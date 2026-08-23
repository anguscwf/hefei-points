const express = require('express');

const { ApiError, sendApiError } = require('../lib/api-error');
const { requireAdultV2 } = require('../lib/v2-auth');
const logger = require('../lib/logger');
const service = require('../services/data-rights');

const router = express.Router();
const CHILD_ID = /^[A-Za-z0-9_-]{2,64}$/;
const REQUEST_ID = /^data_rights_[a-f0-9]{32}$/;

function childId(req) {
  const value = String(req.params.id || '');
  if (!CHILD_ID.test(value)) {
    throw new ApiError({ status: 404, code: 'CHILD_NOT_FOUND', message: '儿童档案不存在' });
  }
  return value;
}

function requestId(req) {
  const value = String(req.params.id || '');
  if (!REQUEST_ID.test(value)) {
    throw new ApiError({
      status: 404,
      code: 'DATA_RIGHTS_REQUEST_NOT_FOUND',
      message: '数据权利请求不存在'
    });
  }
  return value;
}

function endpoint(work) {
  return (req, res) => {
    try {
      const response = work(req);
      if (response && Number.isInteger(response.status) && response.body) {
        return res.status(response.status).json(response.body);
      }
      return res.json(response);
    } catch (error) {
      if (!(error instanceof ApiError)) {
        (req.log || logger).error({
          event: 'v2.data-rights.failed',
          method: req.method,
          path: req.originalUrl.split('?')[0],
          errorType: error.name || 'unexpected'
        }, 'data rights request failed');
      }
      return sendApiError(req, res, error);
    }
  };
}

router.post('/v2/children/:id/data-rights-requests', endpoint(req => service.createRequest({
  actor: requireAdultV2(req),
  childId: childId(req),
  body: req.body,
  idempotencyKey: req.get('Idempotency-Key'),
  requestId: req.requestId,
  now: new Date()
})));

router.get('/v2/data-rights-requests', endpoint(req => service.listRequests({
  actor: requireAdultV2(req),
  query: req.query,
  body: req.body
})));

router.get('/v2/data-rights-requests/:id', endpoint(req => service.getRequest({
  actor: requireAdultV2(req),
  dataRightsRequestId: requestId(req),
  query: req.query,
  body: req.body
})));

router.get('/v2/children/:id/data-export', endpoint(req => service.exportChildData({
  actor: requireAdultV2(req),
  childId: childId(req),
  query: req.query,
  body: req.body,
  now: new Date()
})));

module.exports = router;
