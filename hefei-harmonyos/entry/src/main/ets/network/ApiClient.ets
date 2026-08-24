import { http } from '@kit.NetworkKit';
import { ApiEnvironment } from '../config/ApiEnvironment';
import {
  ClaimPairingRequest,
  ClaimPairingResponse,
  PairingCompletionResponse,
  parseApiErrorCode,
  parseClaimResponse,
  parseCompletionResponse,
  parseProofResponse,
  parseRefreshResponse,
  parseSummaryResponse,
  parseTransactionsResponse,
  ProofResponse,
  RefreshResponse,
  SessionDto,
  SummaryResponse,
  TransactionsResponse,
  validateClaimRequest
} from './ApiContracts';

export class ChildApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly outcomeUnknown: boolean;
  readonly transient: boolean;

  constructor(code: string, status: number, outcomeUnknown: boolean, transient: boolean) {
    super(code);
    this.code = code;
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
    this.transient = transient;
  }
}

export interface TransportRequest {
  method: string;
  path: string;
  body: string;
  bearer: string;
  idempotencyKey: string;
  mutating: boolean;
}

export interface TransportResponse {
  status: number;
  body: string;
}

export interface ApiTransport {
  request(value: TransportRequest): Promise<TransportResponse>;
}

interface ChildRequestHeaders {
  Accept: string;
  'Content-Type': string;
  Authorization?: string;
  'Idempotency-Key'?: string;
}

function methodValue(method: string): http.RequestMethod {
  if (method === 'GET') {
    return http.RequestMethod.GET;
  }
  if (method === 'POST') {
    return http.RequestMethod.POST;
  }
  throw new ChildApiError('LOCAL_REQUEST_INVALID', 0, false, false);
}

function allowedTransportPath(path: string): boolean {
  if (path === '/api/v2/device-pairings/claim-by-code'
      || path === '/api/v2/device-pairings/claim/complete'
      || path === '/api/v2/device-sessions/refresh'
      || path === '/api/v2/me/summary') {
    return true;
  }
  if (/^\/api\/v2\/me\/transactions\?limit=(?:[1-9]|[1-4][0-9]|50)(?:&cursor=[A-Za-z0-9_-]{92})?$/.test(path)) {
    return true;
  }
  return /^\/api\/v2\/devices\/[A-Za-z0-9_-]{8,128}\/session-challenges$/.test(path);
}

export class HarmonyHttpTransport implements ApiTransport {
  async request(value: TransportRequest): Promise<TransportResponse> {
    try {
      ApiEnvironment.assertUsable();
    } catch (_) {
      throw new ChildApiError('LOCAL_ENVIRONMENT_DISABLED', 0, false, false);
    }
    if (!allowedTransportPath(value.path) || value.path.includes('://')
        || value.path.includes('\\') || value.path.includes('\r') || value.path.includes('\n')) {
      throw new ChildApiError('LOCAL_REQUEST_INVALID', 0, false, false);
    }
    const headers: ChildRequestHeaders = value.bearer.length > 0
      && value.idempotencyKey.length > 0
      ? {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${value.bearer}`,
        'Idempotency-Key': value.idempotencyKey
      }
      : value.bearer.length > 0
        ? {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${value.bearer}`
        }
        : value.idempotencyKey.length > 0
        ? {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': value.idempotencyKey
        }
        : {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        };
    const request: http.HttpRequest = http.createHttp();
    try {
      const response: http.HttpResponse = await request.request(
        `${ApiEnvironment.API_ORIGIN}${value.path}`,
        {
          method: methodValue(value.method),
          header: headers,
          extraData: value.body,
          expectDataType: http.HttpDataType.STRING,
          usingCache: false,
          connectTimeout: ApiEnvironment.CONNECT_TIMEOUT_MS,
          readTimeout: ApiEnvironment.READ_TIMEOUT_MS
        }
      );
      if (typeof response.result !== 'string') {
        throw new ChildApiError('PROTOCOL_ERROR', response.responseCode as number,
          value.mutating, false);
      }
      return { status: response.responseCode as number, body: response.result };
    } catch (error) {
      if (error instanceof ChildApiError) {
        throw error;
      }
      throw new ChildApiError('NETWORK_UNAVAILABLE', 0, value.mutating, true);
    } finally {
      request.destroy();
    }
  }
}

function statusError(response: TransportResponse, mutating: boolean): ChildApiError {
  if (response.status >= 500) {
    return new ChildApiError('SERVER_UNAVAILABLE', response.status, mutating, true);
  }
  return new ChildApiError(parseApiErrorCode(response.body), response.status, false,
    response.status === 429);
}

function protocolFailure(mutating: boolean): ChildApiError {
  return new ChildApiError('PROTOCOL_ERROR', 0, mutating, false);
}

export class ChildApiClient {
  private readonly transport: ApiTransport;

  constructor(transport: ApiTransport) {
    this.transport = transport;
  }

  private async send(request: TransportRequest): Promise<TransportResponse> {
    const response: TransportResponse = await this.transport.request(request);
    if (response.status < 200 || response.status >= 300) {
      throw statusError(response, request.mutating);
    }
    return response;
  }

  async claimPairing(body: ClaimPairingRequest,
    idempotencyKey: string): Promise<ClaimPairingResponse> {
    validateClaimRequest(body);
    const response: TransportResponse = await this.send({
      method: 'POST',
      path: '/api/v2/device-pairings/claim-by-code',
      body: JSON.stringify(body),
      bearer: '',
      idempotencyKey,
      mutating: true
    });
    try {
      return parseClaimResponse(response.body);
    } catch (_) {
      throw protocolFailure(true);
    }
  }

  async completePairing(claimToken: string, signatureBase64url: string,
    idempotencyKey: string, devicePublicId: string,
    proofBindingId: string): Promise<PairingCompletionResponse> {
    const response: TransportResponse = await this.send({
      method: 'POST',
      path: '/api/v2/device-pairings/claim/complete',
      body: JSON.stringify({ signatureBase64url }),
      bearer: claimToken,
      idempotencyKey,
      mutating: true
    });
    try {
      return parseCompletionResponse(response.body, devicePublicId, proofBindingId);
    } catch (_) {
      throw protocolFailure(true);
    }
  }

  async issueRefreshChallenge(bindingId: string, session: SessionDto,
    idempotencyKey: string): Promise<ProofResponse> {
    const response: TransportResponse = await this.send({
      method: 'POST',
      path: `/api/v2/devices/${bindingId}/session-challenges`,
      body: '',
      bearer: session.refreshToken,
      idempotencyKey,
      mutating: true
    });
    try {
      return parseProofResponse(response.body, bindingId, session.id);
    } catch (_) {
      throw protocolFailure(true);
    }
  }

  async refreshSession(previous: SessionDto, challengeId: string,
    signatureBase64url: string, idempotencyKey: string): Promise<RefreshResponse> {
    const response: TransportResponse = await this.send({
      method: 'POST',
      path: '/api/v2/device-sessions/refresh',
      body: JSON.stringify({ challengeId, signatureBase64url }),
      bearer: previous.refreshToken,
      idempotencyKey,
      mutating: true
    });
    try {
      return parseRefreshResponse(response.body, previous);
    } catch (_) {
      throw protocolFailure(true);
    }
  }

  async getSummary(accessToken: string): Promise<SummaryResponse> {
    const response: TransportResponse = await this.send({
      method: 'GET',
      path: '/api/v2/me/summary',
      body: '',
      bearer: accessToken,
      idempotencyKey: '',
      mutating: false
    });
    try {
      return parseSummaryResponse(response.body);
    } catch (_) {
      throw protocolFailure(false);
    }
  }

  async getTransactions(accessToken: string, limit: number,
    cursor: string = ''): Promise<TransactionsResponse> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new ChildApiError('LOCAL_REQUEST_INVALID', 0, false, false);
    }
    if (cursor.length > 0 && !/^[A-Za-z0-9_-]{92}$/.test(cursor)) {
      throw new ChildApiError('LOCAL_REQUEST_INVALID', 0, false, false);
    }
    const path: string = cursor.length > 0
      ? `/api/v2/me/transactions?limit=${limit}&cursor=${encodeURIComponent(cursor)}`
      : `/api/v2/me/transactions?limit=${limit}`;
    const response: TransportResponse = await this.send({
      method: 'GET',
      path,
      body: '',
      bearer: accessToken,
      idempotencyKey: '',
      mutating: false
    });
    try {
      return parseTransactionsResponse(response.body);
    } catch (_) {
      throw protocolFailure(false);
    }
  }
}
