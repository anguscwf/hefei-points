const express = require('express');

const { ApiError, sendApiError } = require('../lib/api-error');
const { requireDeviceV2 } = require('../lib/v2-auth');
const logger = require('../lib/logger');
const service = require('../services/child-self');

const router = express.Router();

function endpoint(work) {
  return (req, res) => {
    try {
      return res.json(work(req));
    } catch (error) {
      if (!(error instanceof ApiError)) {
        (req.log || logger).error({
          event: 'v2.child-self.failed',
          method: req.method,
          path: req.originalUrl.split('?')[0],
          errorType: error.name || 'unexpected'
        }, 'child self-only request failed');
      }
      return sendApiError(req, res, error);
    }
  };
}

router.get('/v2/me/summary', endpoint(req => {
  const now = new Date();
  return service.summary({
    actor: requireDeviceV2(req, now),
    query: req.query,
    body: req.body,
    now
  });
}));

router.get('/v2/me/transactions', endpoint(req => {
  const now = new Date();
  return service.transactions({
    actor: requireDeviceV2(req, now),
    query: req.query,
    body: req.body,
    now
  });
}));

module.exports = router;
