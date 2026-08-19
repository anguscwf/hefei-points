const express = require('express');
const router = express.Router();
const { getDb } = require('../db/connection');

router.get('/health/live', (req, res) => {
  res.json({ status: 'ok', requestId: req.requestId });
});

router.get('/health/ready', (req, res) => {
  try {
    const result = getDb().prepare('SELECT 1 AS ready').get();
    if (result?.ready !== 1) throw new Error('SQLite readiness query failed');
    res.json({ status: 'ready', requestId: req.requestId });
  } catch (error) {
    req.log.error({ event: 'health.ready.failed', error: error.message }, 'readiness check failed');
    res.status(503).json({ status: 'not_ready', requestId: req.requestId });
  }
});

module.exports = router;
