const { getDb } = require('../connection');

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function toRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    familyId: row.family_id,
    childId: row.child_id,
    deviceBindingId: row.device_binding_id,
    clientRequestId: row.client_request_id,
    requestFingerprint: row.request_fingerprint,
    ruleId: row.rule_id,
    categoryId: row.category_id,
    ruleRevision: Number(row.rule_revision),
    ruleLabel: row.rule_label_snapshot,
    categoryLabel: row.category_label_snapshot,
    ruleUnit: row.rule_unit_snapshot || '',
    ruleMinPoints: Number(row.rule_min_points),
    ruleDefaultPoints: Number(row.rule_default_points),
    ruleMaxPoints: Number(row.rule_max_points),
    childAlias: row.child_alias_snapshot,
    requestedPoints: Number(row.requested_points),
    approvedPoints: row.approved_points === null ? null : Number(row.approved_points),
    description: row.description,
    occurredAt: row.occurred_at,
    periodKey: row.period_key,
    duplicateSuspected: Boolean(row.duplicate_suspected),
    status: row.status,
    revision: Number(row.revision),
    requestInfoNote: row.request_info_note || null,
    requestInfoAt: row.request_info_at || null,
    resubmittedAt: row.resubmitted_at || null,
    decisionNote: row.decision_note || null,
    reviewerUserId: row.reviewer_user_id || null,
    reviewedAt: row.reviewed_at || null,
    transactionId: row.transaction_id || null,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at
  };
}

function toEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    familyId: row.family_id,
    childId: row.child_id,
    pointRequestId: row.point_request_id,
    actorUserId: row.actor_user_id || null,
    actorDeviceBindingId: row.actor_device_binding_id || null,
    action: row.action,
    idempotencyKeyHash: row.idempotency_key_hash,
    requestFingerprint: row.request_fingerprint,
    fromStatus: row.from_status || null,
    toStatus: row.to_status,
    resultRevision: Number(row.result_revision),
    responseStatus: Number(row.response_status),
    transactionId: row.transaction_id || null,
    eventData: parseJson(row.event_data_json),
    createdAt: row.created_at
  };
}

function consentAllowsDevice(consent) {
  return Boolean(
    consent
    && consent.consentScope
    && consent.consentScope.pointsLedger === true
    && consent.consentScope.pointRequests === true
    && consent.visibilityScope
    && consent.visibilityScope.childDevice === 'self_only'
  );
}

function consentAllowsAdult(consent) {
  return Boolean(
    consent
    && consent.consentScope
    && consent.consentScope.pointsLedger === true
    && consent.consentScope.pointRequests === true
    && consent.visibilityScope
    && consent.visibilityScope.guardian === 'full'
  );
}

function inspectDeviceScope(input, db = getDb()) {
  const row = db.prepare(`
    SELECT session.id AS session_id,
           binding.created_by_guardian_id,
           privacy.status AS privacy_status,
           child.id AS child_id,
           child.name AS child_name,
           account.balance
    FROM device_sessions AS session
    JOIN device_bindings AS binding
      ON binding.id = session.device_binding_id
     AND binding.family_id = session.family_id
     AND binding.child_id = session.child_id
    JOIN users AS child
      ON child.family_id = session.family_id
     AND child.id = session.child_id
     AND child.role = 'child'
    LEFT JOIN child_privacy_states AS privacy
      ON privacy.family_id = session.family_id
     AND privacy.child_id = session.child_id
    LEFT JOIN point_accounts AS account
      ON account.family_id = session.family_id
     AND account.kid_id = session.child_id
    WHERE session.id = ?
      AND session.family_id = ?
      AND session.child_id = ?
      AND session.device_binding_id = ?
      AND session.token_family_id = ?
      AND session.rotation_counter = ?
      AND session.status = 'active'
      AND session.access_expires_at > ?
      AND binding.status = 'active'
  `).get(
    input.sessionId,
    input.familyId,
    input.childId,
    input.deviceBindingId,
    input.tokenFamilyId,
    input.rotationCounter,
    input.now
  );
  if (!row) return { ok: false, reason: 'session' };
  if (row.privacy_status !== 'active') return { ok: false, reason: 'privacy' };
  const consent = db.prepare(`
    SELECT consent_scope_json, visibility_scope_json
    FROM guardian_consents
    WHERE family_id = ? AND child_id = ? AND guardian_id = ? AND status = 'active'
    ORDER BY consent_version DESC
    LIMIT 1
  `).get(input.familyId, input.childId, row.created_by_guardian_id);
  const normalizedConsent = consent && {
    consentScope: parseJson(consent.consent_scope_json),
    visibilityScope: parseJson(consent.visibility_scope_json)
  };
  if (!consentAllowsDevice(normalizedConsent)) return { ok: false, reason: 'consent' };
  if (row.balance === null || row.balance === undefined) return { ok: false, reason: 'account' };
  return {
    ok: true,
    child: { id: row.child_id, name: row.child_name },
    balance: Number(row.balance)
  };
}

function inspectAdultChildScope(input, db = getDb()) {
  const row = db.prepare(`
    SELECT adult.name AS adult_name, child.id AS child_id, child.name AS child_name,
           privacy.status AS privacy_status, account.balance
    FROM users AS adult
    JOIN users AS child
      ON child.family_id = adult.family_id
     AND child.id = ?
     AND child.role = 'child'
    LEFT JOIN child_privacy_states AS privacy
      ON privacy.family_id = child.family_id
     AND privacy.child_id = child.id
    LEFT JOIN point_accounts AS account
      ON account.family_id = child.family_id
     AND account.kid_id = child.id
    WHERE adult.id = ?
      AND adult.family_id = ?
      AND adult.role IN ('admin', 'parent')
  `).get(input.childId, input.actorUserId, input.familyId);
  if (!row) return { ok: false, reason: 'scope' };
  if (row.privacy_status !== 'active') return { ok: false, reason: 'privacy' };
  const consent = db.prepare(`
    SELECT consent_scope_json, visibility_scope_json
    FROM guardian_consents
    WHERE family_id = ? AND child_id = ? AND guardian_id = ? AND status = 'active'
    ORDER BY consent_version DESC
    LIMIT 1
  `).get(input.familyId, input.childId, input.actorUserId);
  const normalizedConsent = consent && {
    consentScope: parseJson(consent.consent_scope_json),
    visibilityScope: parseJson(consent.visibility_scope_json)
  };
  if (!consentAllowsAdult(normalizedConsent)) return { ok: false, reason: 'consent' };
  if (row.balance === null || row.balance === undefined) return { ok: false, reason: 'account' };
  return {
    ok: true,
    adult: { id: input.actorUserId, name: row.adult_name },
    child: { id: row.child_id, name: row.child_name },
    balance: Number(row.balance)
  };
}

function currentRewardRule(input, db = getDb()) {
  const row = db.prepare(`
    SELECT revision, data_json FROM rules WHERE family_id = ?
  `).get(input.familyId);
  if (!row) return null;
  const rules = parseJson(row.data_json, null);
  if (!rules || !Array.isArray(rules.reward)) return null;
  for (const category of rules.reward) {
    const items = Array.isArray(category && category.items) ? category.items : [];
    const item = items.find(candidate => candidate && candidate.id === input.ruleId);
    if (item) {
      return {
        ruleRevision: Number(row.revision),
        ruleId: item.id,
        categoryId: category.id,
        ruleLabel: item.label,
        categoryLabel: category.category,
        ruleUnit: typeof item.unit === 'string' ? item.unit : '',
        min: Number(item.min),
        default: Number(item.default),
        max: Number(item.max)
      };
    }
  }
  return null;
}

function findById(input, db = getDb()) {
  return toRequest(db.prepare(`
    SELECT * FROM point_requests
    WHERE id = ? AND family_id = ?
  `).get(input.id, input.familyId));
}

function findByDeviceClientRequest(input, db = getDb()) {
  return toRequest(db.prepare(`
    SELECT * FROM point_requests
    WHERE device_binding_id = ? AND client_request_id = ?
  `).get(input.deviceBindingId, input.clientRequestId));
}

function insertEvent(input, db = getDb()) {
  db.prepare(`
    INSERT INTO point_request_events(
      id, family_id, child_id, point_request_id,
      actor_user_id, actor_device_binding_id, action,
      idempotency_key_hash, request_fingerprint,
      from_status, to_status, result_revision, response_status,
      transaction_id, event_data_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.familyId,
    input.childId,
    input.pointRequestId,
    input.actorUserId || null,
    input.actorDeviceBindingId || null,
    input.action,
    input.idempotencyKeyHash,
    input.requestFingerprint,
    input.fromStatus || null,
    input.toStatus,
    input.resultRevision,
    input.responseStatus,
    input.transactionId || null,
    JSON.stringify(input.eventData || {}),
    input.createdAt
  );
  return findEventById({ id: input.id }, db);
}

function findEventById(input, db = getDb()) {
  return toEvent(db.prepare('SELECT * FROM point_request_events WHERE id = ?').get(input.id));
}

function findDeviceEvent(input, db = getDb()) {
  return toEvent(db.prepare(`
    SELECT * FROM point_request_events
    WHERE actor_device_binding_id = ?
      AND action = ?
      AND idempotency_key_hash = ?
  `).get(input.deviceBindingId, input.action, input.idempotencyKeyHash));
}

function findAdultEvent(input, db = getDb()) {
  return toEvent(db.prepare(`
    SELECT * FROM point_request_events
    WHERE family_id = ?
      AND actor_user_id = ?
      AND action = ?
      AND idempotency_key_hash = ?
  `).get(input.familyId, input.actorUserId, input.action, input.idempotencyKeyHash));
}

function insertRequest(input, db = getDb()) {
  db.prepare(`
    INSERT INTO point_requests(
      id, family_id, child_id, device_binding_id,
      client_request_id, request_fingerprint,
      rule_id, category_id, rule_revision,
      rule_label_snapshot, category_label_snapshot, rule_unit_snapshot,
      rule_min_points, rule_default_points, rule_max_points,
      child_alias_snapshot, requested_points, description, occurred_at,
      period_key, duplicate_suspected, submitted_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    input.id,
    input.familyId,
    input.childId,
    input.deviceBindingId,
    input.clientRequestId,
    input.requestFingerprint,
    input.ruleId,
    input.categoryId,
    input.ruleRevision,
    input.ruleLabel,
    input.categoryLabel,
    input.ruleUnit,
    input.ruleMinPoints,
    input.ruleDefaultPoints,
    input.ruleMaxPoints,
    input.childAlias,
    input.requestedPoints,
    input.description,
    input.occurredAt,
    input.periodKey,
    input.duplicateSuspected ? 1 : 0,
    input.submittedAt,
    input.submittedAt
  );
  return findById({ id: input.id, familyId: input.familyId }, db);
}

function hasDuplicateSignal(input, db = getDb()) {
  return Boolean(db.prepare(`
    SELECT 1 FROM point_requests
    WHERE family_id = ? AND child_id = ? AND rule_id = ? AND period_key = ?
      AND status NOT IN ('rejected', 'cancelled')
    LIMIT 1
  `).get(input.familyId, input.childId, input.ruleId, input.periodKey));
}

function updateRequest(input, db = getDb()) {
  let result;
  if (input.action === 'resubmit') {
    result = db.prepare(`
      UPDATE point_requests
      SET status = 'pending', revision = revision + 1,
          description = ?, resubmitted_at = ?, updated_at = ?
      WHERE id = ? AND family_id = ? AND child_id = ?
        AND status = 'needs_info' AND revision = ?
    `).run(
      input.description, input.updatedAt, input.updatedAt,
      input.id, input.familyId, input.childId, input.expectedRevision
    );
  } else if (input.action === 'request_info') {
    result = db.prepare(`
      UPDATE point_requests
      SET status = 'needs_info', revision = revision + 1,
          request_info_note = ?, request_info_at = ?,
          resubmitted_at = NULL, updated_at = ?
      WHERE id = ? AND family_id = ? AND child_id = ?
        AND status = 'pending' AND revision = ?
    `).run(
      input.note, input.updatedAt, input.updatedAt,
      input.id, input.familyId, input.childId, input.expectedRevision
    );
  } else if (input.action === 'approve') {
    result = db.prepare(`
      UPDATE point_requests
      SET status = 'approved', revision = revision + 1,
          approved_points = ?, decision_note = ?, reviewer_user_id = ?,
          reviewed_at = ?, transaction_id = ?, updated_at = ?
      WHERE id = ? AND family_id = ? AND child_id = ?
        AND status = 'pending' AND revision = ?
    `).run(
      input.approvedPoints, input.note || null, input.actorUserId,
      input.updatedAt, input.transactionId, input.updatedAt,
      input.id, input.familyId, input.childId, input.expectedRevision
    );
  } else if (input.action === 'reject') {
    result = db.prepare(`
      UPDATE point_requests
      SET status = 'rejected', revision = revision + 1,
          decision_note = ?, reviewer_user_id = ?, reviewed_at = ?, updated_at = ?
      WHERE id = ? AND family_id = ? AND child_id = ?
        AND status IN ('pending', 'needs_info') AND revision = ?
    `).run(
      input.note, input.actorUserId, input.updatedAt, input.updatedAt,
      input.id, input.familyId, input.childId, input.expectedRevision
    );
  } else if (input.action === 'cancel') {
    result = db.prepare(`
      UPDATE point_requests
      SET status = 'cancelled', revision = revision + 1, updated_at = ?
      WHERE id = ? AND family_id = ? AND child_id = ?
        AND status IN ('pending', 'needs_info') AND revision = ?
    `).run(
      input.updatedAt, input.id, input.familyId, input.childId, input.expectedRevision
    );
  } else {
    throw new Error('unsupported point request action');
  }
  if (result.changes !== 1) return null;
  return findById({ id: input.id, familyId: input.familyId }, db);
}

function listForDevice(input, db = getDb()) {
  const clauses = ['family_id = ?', 'child_id = ?'];
  const params = [input.familyId, input.childId];
  if (input.status) {
    clauses.push('status = ?');
    params.push(input.status);
  }
  if (input.cursor) {
    clauses.push('(submitted_at < ? OR (submitted_at = ? AND id < ?))');
    params.push(input.cursor.submittedAt, input.cursor.submittedAt, input.cursor.id);
  }
  params.push(input.limit);
  return db.prepare(`
    SELECT * FROM point_requests
    WHERE ${clauses.join(' AND ')}
    ORDER BY submitted_at DESC, id DESC
    LIMIT ?
  `).all(...params).map(toRequest);
}

function listForAdult(input, db = getDb()) {
  const status = input.status || 'pending';
  const clauses = [
    'request.family_id = ?',
    "json_extract(consent.consent_scope_json, '$.pointsLedger') = 1",
    "json_extract(consent.consent_scope_json, '$.pointRequests') = 1",
    "json_extract(consent.visibility_scope_json, '$.guardian') = 'full'",
    'request.status = ?'
  ];
  const params = [input.actorUserId, input.familyId, status];
  if (input.childId) {
    clauses.push('request.child_id = ?');
    params.push(input.childId);
  }
  if (input.cursor) {
    clauses.push(`
      (request.submitted_at < ?
        OR (request.submitted_at = ? AND request.id < ?))
    `);
    params.push(input.cursor.submittedAt, input.cursor.submittedAt, input.cursor.id);
  }
  params.push(input.limit);
  return db.prepare(`
    SELECT request.*
    FROM point_requests AS request
    JOIN users AS child
      ON child.family_id = request.family_id
     AND child.id = request.child_id
     AND child.role = 'child'
    JOIN child_privacy_states AS privacy
      ON privacy.family_id = request.family_id
     AND privacy.child_id = request.child_id
     AND privacy.status = 'active'
    JOIN guardian_consents AS consent
      ON consent.family_id = request.family_id
     AND consent.child_id = request.child_id
     AND consent.guardian_id = ?
     AND consent.status = 'active'
    JOIN point_accounts AS account
      ON account.family_id = request.family_id
     AND account.kid_id = request.child_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY request.submitted_at DESC, request.id DESC
    LIMIT ?
  `).all(...params).map(toRequest);
}

function taskSummary(input, db = getDb()) {
  const rows = db.prepare(`
    SELECT request.status, COUNT(*) AS count
    FROM point_requests AS request
    JOIN users AS child
      ON child.family_id = request.family_id
     AND child.id = request.child_id
     AND child.role = 'child'
    JOIN child_privacy_states AS privacy
      ON privacy.family_id = request.family_id
     AND privacy.child_id = request.child_id
     AND privacy.status = 'active'
    JOIN guardian_consents AS consent
      ON consent.family_id = request.family_id
     AND consent.child_id = request.child_id
     AND consent.guardian_id = ?
     AND consent.status = 'active'
    JOIN point_accounts AS account
      ON account.family_id = request.family_id
     AND account.kid_id = request.child_id
    WHERE request.family_id = ?
      AND request.status IN ('pending', 'needs_info')
      AND json_extract(consent.consent_scope_json, '$.pointsLedger') = 1
      AND json_extract(consent.consent_scope_json, '$.pointRequests') = 1
      AND json_extract(consent.visibility_scope_json, '$.guardian') = 'full'
    GROUP BY request.status
  `).all(input.actorUserId, input.familyId);
  const counts = { pending: 0, needsInfo: 0 };
  for (const row of rows) {
    if (row.status === 'pending') counts.pending = Number(row.count);
    if (row.status === 'needs_info') counts.needsInfo = Number(row.count);
  }
  return { ...counts, total: counts.pending + counts.needsInfo };
}

module.exports = {
  toRequest,
  toEvent,
  inspectDeviceScope,
  inspectAdultChildScope,
  currentRewardRule,
  findById,
  findByDeviceClientRequest,
  insertEvent,
  findEventById,
  findDeviceEvent,
  findAdultEvent,
  insertRequest,
  hasDuplicateSignal,
  updateRequest,
  listForDevice,
  listForAdult,
  taskSummary
};
