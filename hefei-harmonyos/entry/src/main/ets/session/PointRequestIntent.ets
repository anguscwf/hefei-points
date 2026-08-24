import {
  parsePointRequestCreateRequest,
  PointRequestCreateRequest
} from '../network/ApiContracts';

export class PointRequestIntentPhase {
  static readonly EMPTY: string = 'EMPTY';
  static readonly CREATE_INTENT: string = 'CREATE_INTENT';
}

export class PointRequestIntent {
  version: number = 1;
  revision: number = 0;
  phase: string = PointRequestIntentPhase.EMPTY;
  bindingId: string = '';
  bodyJson: string = '';
  idempotencyKey: string = '';
}

interface CompactPointRequestIntent {
  v: number;
  r: number;
  p: string;
  b: string;
  j: string;
  k: string;
}

function resourceId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function idempotencyKey(value: string): boolean {
  return /^[\x21-\x7e]{16,128}$/.test(value);
}

export function validatePointRequestIntent(value: PointRequestIntent): void {
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error('LOCAL_POINT_INTENT_CORRUPT');
  }
  if (value.phase === PointRequestIntentPhase.EMPTY) {
    if (value.bindingId.length !== 0 || value.bodyJson.length !== 0
        || value.idempotencyKey.length !== 0) {
      throw new Error('LOCAL_POINT_INTENT_CORRUPT');
    }
    return;
  }
  if (value.phase !== PointRequestIntentPhase.CREATE_INTENT
      || !resourceId(value.bindingId) || !idempotencyKey(value.idempotencyKey)) {
    throw new Error('LOCAL_POINT_INTENT_CORRUPT');
  }
  let body: PointRequestCreateRequest;
  try {
    body = parsePointRequestCreateRequest(value.bodyJson);
  } catch (_) {
    throw new Error('LOCAL_POINT_INTENT_CORRUPT');
  }
  if (JSON.stringify(body) !== value.bodyJson) {
    throw new Error('LOCAL_POINT_INTENT_CORRUPT');
  }
}

export function serializePointRequestIntent(value: PointRequestIntent): string {
  validatePointRequestIntent(value);
  const compact: CompactPointRequestIntent = {
    v: value.version,
    r: value.revision,
    p: value.phase,
    b: value.bindingId,
    j: value.bodyJson,
    k: value.idempotencyKey
  };
  return JSON.stringify(compact);
}

export function parsePointRequestIntent(text: string): PointRequestIntent {
  let compact: CompactPointRequestIntent;
  try {
    compact = JSON.parse(text) as CompactPointRequestIntent;
    const keys: Array<string> = Object.keys(compact as Object);
    const allowed: Array<string> = ['v', 'r', 'p', 'b', 'j', 'k'];
    if (keys.length !== allowed.length
        || keys.some((key: string) => allowed.indexOf(key) < 0)) {
      throw new Error('LOCAL_POINT_INTENT_CORRUPT');
    }
  } catch (_) {
    throw new Error('LOCAL_POINT_INTENT_CORRUPT');
  }
  const value: PointRequestIntent = new PointRequestIntent();
  value.version = compact.v;
  value.revision = compact.r;
  value.phase = compact.p;
  value.bindingId = compact.b;
  value.bodyJson = compact.j;
  value.idempotencyKey = compact.k;
  validatePointRequestIntent(value);
  return value;
}

export function copyPointRequestIntent(source: PointRequestIntent): PointRequestIntent {
  return parsePointRequestIntent(serializePointRequestIntent(source));
}

export function emptyPointRequestIntent(): PointRequestIntent {
  const value: PointRequestIntent = new PointRequestIntent();
  validatePointRequestIntent(value);
  return value;
}

export function createPointRequestIntent(bindingId: string, body: PointRequestCreateRequest,
  idempotencyKeyValue: string): PointRequestIntent {
  const value: PointRequestIntent = emptyPointRequestIntent();
  value.phase = PointRequestIntentPhase.CREATE_INTENT;
  value.bindingId = bindingId;
  value.bodyJson = JSON.stringify(body);
  value.idempotencyKey = idempotencyKeyValue;
  validatePointRequestIntent(value);
  return value;
}

export function bodyFromPointRequestIntent(value: PointRequestIntent): PointRequestCreateRequest {
  validatePointRequestIntent(value);
  if (value.phase !== PointRequestIntentPhase.CREATE_INTENT) {
    throw new Error('LOCAL_POINT_INTENT_EMPTY');
  }
  return parsePointRequestCreateRequest(value.bodyJson);
}
