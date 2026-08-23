const express = require('express');

const features = require('../config/features');
const { ApiError, sendApiError } = require('../lib/api-error');
const { requireAdultV2 } = require('../lib/v2-auth');
const logger = require('../lib/logger');
const service = require('../services/guardian-consents');

const router = express.Router();
const CHILD_ID = /^[A-Za-z0-9_-]{2,64}$/;

function childId(req) {
  if (!CHILD_ID.test(String(req.params.id || ''))) {
    throw new ApiError({ status: 404, code: 'CHILD_NOT_FOUND', message: '儿童档案不存在' });
  }
  return req.params.id;
}

function requireEnrollmentGate() {
  if (!features.isHarmonyChildEnabled() || !features.isChildEnrollmentEnabled()) {
    throw new ApiError({
      status: 403,
      code: 'FEATURE_DISABLED',
      message: '监护授权与儿童建档当前未开放'
    });
  }
}

function endpoint(work) {
  return (req, res) => {
    try {
      const result = work(req);
      if (result && Number.isInteger(result.status) && result.body) {
        return res.status(result.status).json(result.body);
      }
      return res.json(result);
    } catch (error) {
      if (!(error instanceof ApiError)) {
        (req.log || logger).error({
          event: 'v2.guardian-consent.failed',
          method: req.method,
          path: req.originalUrl.split('?')[0],
          errorType: error.name || 'unexpected'
        }, 'guardian consent request failed');
      }
      return sendApiError(req, res, error);
    }
  };
}

router.get('/v2/legal-texts/current', endpoint(() => service.publicLegalTexts()));

router.post('/v2/reauth-assertions', endpoint(req => service.issueReauthAssertion({
  actor: requireAdultV2(req),
  body: req.body
})));

router.post('/v2/child-enrollments', endpoint(req => {
  const actor = requireAdultV2(req);
  requireEnrollmentGate();
  return service.enrollChild({
    actor,
    body: req.body,
    idempotencyKey: req.get('Idempotency-Key'),
    requestId: req.requestId
  });
}));

router.get('/v2/guardian-consent-operations/:operation', endpoint(req => service.getOperationStatus({
  actor: requireAdultV2(req),
  operation: String(req.params.operation || ''),
  idempotencyKey: req.get('Idempotency-Key'),
  query: req.query,
  body: req.body
})));

router.get('/v2/children', endpoint(req => service.listChildren({
  actor: requireAdultV2(req),
  query: req.query,
  body: req.body
})));

router.get('/v2/children/:id/consents', endpoint(req => service.listConsents({
  actor: requireAdultV2(req),
  childId: childId(req)
})));

router.post('/v2/children/:id/consents', endpoint(req => {
  const actor = requireAdultV2(req);
  requireEnrollmentGate();
  return service.recordConsent({
    actor,
    childId: childId(req),
    body: req.body,
    idempotencyKey: req.get('Idempotency-Key'),
    requestId: req.requestId
  });
}));

router.post('/v2/children/:id/consents/withdraw', endpoint(req => service.withdrawConsent({
  actor: requireAdultV2(req),
  childId: childId(req),
  body: req.body,
  idempotencyKey: req.get('Idempotency-Key')
})));

module.exports = router;
