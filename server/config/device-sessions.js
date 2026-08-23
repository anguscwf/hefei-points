module.exports = Object.freeze({
  pairingTtlMs: 10 * 60 * 1000,
  pairingProofTtlMs: 5 * 60 * 1000,
  sessionChallengeTtlMs: 5 * 60 * 1000,
  idempotencyReplayTtlMs: 5 * 60 * 1000,
  accessTokenTtlMs: 15 * 60 * 1000,
  refreshEligibilityWindowMs: 5 * 60 * 1000,
  refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
  pairingAttemptWindowMs: 10 * 60 * 1000,
  pairingAttemptLockMs: 10 * 60 * 1000,
  pairingAttemptMaxRows: 10_000,
  deviceAttemptLimit: 5,
  networkAttemptLimit: 20,
  proofAttemptLimit: 5
});
