const express = require('express');

const { ApiError, sendApiError } = require('../lib/api-error');
const {
  requireAdultV2,
  requireRefreshV2,
  requirePairingClaimV2
} = require('../lib/v2-auth');
const logger = require('../lib/logger');
const service = require('../services/device-pairing-sessions');

const router = express.Router();

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
          event: 'v2.device-session.failed',
          method: req.method,
          path: req.originalUrl.split('?')[0],
          errorType: error.name || 'unexpected'
        }, 'device session request failed');
      }
      return sendApiError(req, res, error);
    }
  };
}

router.post('/v2/device-pairings', endpoint(req => service.createPairing({
  actor: requireAdultV2(req),
  body: req.body,
  idempotencyKey: req.get('Idempotency-Key')
})));

router.post('/v2/device-pairings/claim-by-code', endpoint(req => service.claimPairing({
  body: req.body,
  idempotencyKey: req.get('Idempotency-Key'),
  networkKey: `${req.ip || ''}|${req.socket.remoteAddress || ''}`
})));

router.post('/v2/device-pairings/claim/complete', endpoint(req => service.completePairing({
  claimToken: requirePairingClaimV2(req),
  body: req.body,
  idempotencyKey: req.get('Idempotency-Key')
})));

router.get('/v2/device-pairings/:id', endpoint(req => service.getPairing({
  actor: requireAdultV2(req),
  pairingId: req.params.id
})));

router.post('/v2/device-pairings/:id/confirm', endpoint(req => service.confirmPairing({
  actor: requireAdultV2(req),
  pairingId: req.params.id,
  body: req.body,
  idempotencyKey: req.get('Idempotency-Key')
})));

router.get('/v2/devices', endpoint(req => service.listDevices({
  actor: requireAdultV2(req)
})));

router.delete('/v2/devices/:id', endpoint(req => service.revokeDevice({
  actor: requireAdultV2(req),
  bindingId: req.params.id,
  body: req.body,
  idempotencyKey: req.get('Idempotency-Key')
})));

router.post('/v2/devices/:id/session-challenges', endpoint(req => service.issueSessionChallenge({
  refreshToken: requireRefreshV2(req),
  bindingId: req.params.id,
  idempotencyKey: req.get('Idempotency-Key')
})));

router.post('/v2/device-sessions/refresh', endpoint(req => service.refreshSession({
  refreshToken: requireRefreshV2(req),
  body: req.body,
  idempotencyKey: req.get('Idempotency-Key')
})));

router.delete('/v2/device-sessions/:id', endpoint(req => service.revokeSession({
  actor: requireAdultV2(req),
  sessionId: req.params.id,
  body: req.body,
  idempotencyKey: req.get('Idempotency-Key')
})));

module.exports = router;
