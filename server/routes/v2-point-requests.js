const express = require('express');

const { ApiError, sendApiError } = require('../lib/api-error');
const { requireAdultV2, requireDeviceV2 } = require('../lib/v2-auth');
const logger = require('../lib/logger');
const service = require('../services/point-requests');

const router = express.Router();
const REQUEST_ID = /^point_request_[a-f0-9]{32}$/;

function pointRequestId(req) {
  const value = String(req.params.id || '');
  if (!REQUEST_ID.test(value)) {
    throw new ApiError({
      status: 404,
      code: 'POINT_REQUEST_NOT_FOUND',
      message: '积分申请不存在'
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
          event: 'v2.point-request.failed',
          method: req.method,
          path: req.originalUrl.split('?')[0],
          errorType: error.name || 'unexpected'
        }, 'point request failed');
      }
      return sendApiError(req, res, error);
    }
  };
}

function adult(req) {
  service.assertEnabled();
  return requireAdultV2(req);
}

function device(req, now) {
  service.assertEnabled();
  return requireDeviceV2(req, now);
}

router.get('/v2/me/reward-rules', endpoint(req => {
  const now = new Date();
  return service.listRewardRules({
    actor: device(req, now), query: req.query, body: req.body, now
  });
}));

router.get('/v2/me/point-requests', endpoint(req => {
  const now = new Date();
  return service.listMine({
    actor: device(req, now), query: req.query, body: req.body, now
  });
}));

router.get('/v2/me/point-requests/:id', endpoint(req => {
  const now = new Date();
  return service.getMine({
    actor: device(req, now),
    requestId: pointRequestId(req),
    query: req.query,
    body: req.body,
    now
  });
}));

function reconcileDeviceMutation(action) {
  return endpoint(req => {
    const now = new Date();
    return service.reconcileDeviceMutation({
      actor: requireDeviceV2(req, now),
      action,
      body: req.body,
      query: req.query,
      idempotencyKey: req.get('Idempotency-Key'),
      now
    });
  });
}

router.post(
  '/v2/me/point-request-operations/resubmit/reconcile',
  reconcileDeviceMutation('resubmit')
);

router.post(
  '/v2/me/point-request-operations/cancel/reconcile',
  reconcileDeviceMutation('cancel')
);

router.post('/v2/point-requests', endpoint(req => {
  const now = new Date();
  return service.createRequest({
    actor: device(req, now),
    body: req.body,
    idempotencyKey: req.get('Idempotency-Key'),
    now
  });
}));

router.get('/v2/point-requests', endpoint(req => service.listForAdult({
  actor: adult(req), query: req.query, body: req.body
})));

router.get('/v2/family/tasks/summary', endpoint(req => service.tasksSummary({
  actor: adult(req), query: req.query, body: req.body
})));

router.get('/v2/point-requests/:id', endpoint(req => service.getForAdult({
  actor: adult(req), requestId: pointRequestId(req), query: req.query, body: req.body
})));

router.patch('/v2/point-requests/:id', endpoint(req => {
  const now = new Date();
  return service.mutateByDevice({
    actor: device(req, now),
    requestId: pointRequestId(req),
    action: 'resubmit',
    body: req.body,
    idempotencyKey: req.get('Idempotency-Key'),
    now
  });
}));

router.post('/v2/point-requests/:id/cancel', endpoint(req => {
  const now = new Date();
  return service.mutateByDevice({
    actor: device(req, now),
    requestId: pointRequestId(req),
    action: 'cancel',
    body: req.body,
    idempotencyKey: req.get('Idempotency-Key'),
    now
  });
}));

router.post('/v2/point-requests/:id/request-info', endpoint(req => service.mutateByAdult({
  actor: adult(req),
  requestId: pointRequestId(req),
  action: 'request_info',
  body: req.body,
  idempotencyKey: req.get('Idempotency-Key')
})));

router.post('/v2/point-requests/:id/approve', endpoint(req => service.mutateByAdult({
  actor: adult(req),
  requestId: pointRequestId(req),
  action: 'approve',
  body: req.body,
  idempotencyKey: req.get('Idempotency-Key')
})));

router.post('/v2/point-requests/:id/reject', endpoint(req => service.mutateByAdult({
  actor: adult(req),
  requestId: pointRequestId(req),
  action: 'reject',
  body: req.body,
  idempotencyKey: req.get('Idempotency-Key')
})));

module.exports = router;
