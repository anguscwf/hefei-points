import { asset } from '@kit.AssetStoreKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { bytesEqual, utf8Decode, utf8Encode } from './Encoding';
import { copyEnvelope, parseEnvelope, serializeEnvelope, SessionEnvelope } from '../session/SessionEnvelope';

const STATE_ALIAS: string = 'tangguan.s7.child-session.v1';
const MAX_SECRET_BYTES: number = 1024;
let vaultWriteInProgress: boolean = false;

function aliasBytes(): Uint8Array {
  return utf8Encode(STATE_ALIAS);
}

function aliasQuery(): asset.AssetMap {
  const query: asset.AssetMap = new Map();
  query.set(asset.Tag.ALIAS, aliasBytes());
  return query;
}

function loadQuery(): asset.AssetMap {
  const query: asset.AssetMap = aliasQuery();
  query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
  return query;
}

export class SessionVault {
  async load(): Promise<SessionEnvelope | null> {
    let result: Array<asset.AssetMap>;
    try {
      result = await asset.query(loadQuery());
    } catch (error) {
      const businessError: BusinessError = error as BusinessError;
      if (businessError.code === 24000002) {
        return null;
      }
      throw new Error('LOCAL_STATE_LOAD_FAILED');
    }
    if (result.length === 0) {
      return null;
    }
    if (result.length !== 1) {
      throw new Error('LOCAL_STATE_CORRUPT');
    }
    const secret: Uint8Array = result[0].get(asset.Tag.SECRET) as Uint8Array;
    if (!secret || secret.length < 2 || secret.length > MAX_SECRET_BYTES) {
      throw new Error('LOCAL_STATE_CORRUPT');
    }
    return parseEnvelope(utf8Decode(secret));
  }

  async saveVerified(input: SessionEnvelope): Promise<SessionEnvelope> {
    if (vaultWriteInProgress) {
      throw new Error('LOCAL_STATE_CONFLICT');
    }
    vaultWriteInProgress = true;
    try {
      const current: SessionEnvelope | null = await this.load();
      if ((current === null && input.revision !== 0)
          || (current !== null && current.revision !== input.revision)) {
        throw new Error('LOCAL_STATE_CONFLICT');
      }
      const next: SessionEnvelope = copyEnvelope(input);
      next.revision += 1;
      const secret: Uint8Array = utf8Encode(serializeEnvelope(next));
      if (secret.length > MAX_SECRET_BYTES) {
        throw new Error('LOCAL_STATE_TOO_LARGE');
      }
      if (current === null) {
        const attributes: asset.AssetMap = new Map();
        attributes.set(asset.Tag.ALIAS, aliasBytes());
        attributes.set(asset.Tag.SECRET, secret);
        attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_UNLOCKED);
        attributes.set(asset.Tag.REQUIRE_PASSWORD_SET, true);
        attributes.set(asset.Tag.AUTH_TYPE, asset.AuthType.NONE);
        attributes.set(asset.Tag.SYNC_TYPE, asset.SyncType.NEVER);
        attributes.set(asset.Tag.IS_PERSISTENT, false);
        attributes.set(asset.Tag.CONFLICT_RESOLUTION, asset.ConflictResolution.THROW_ERROR);
        try {
          await asset.add(attributes);
        } catch (_) {
          throw new Error('LOCAL_STATE_COMMIT_FAILED');
        }
      } else {
        const update: asset.AssetMap = new Map();
        update.set(asset.Tag.SECRET, secret);
        try {
          await asset.update(aliasQuery(), update);
        } catch (_) {
          throw new Error('LOCAL_STATE_COMMIT_FAILED');
        }
      }

      const committed: SessionEnvelope | null = await this.load();
      if (committed === null) {
        throw new Error('LOCAL_STATE_COMMIT_FAILED');
      }
      const expected: Uint8Array = utf8Encode(serializeEnvelope(next));
      const actual: Uint8Array = utf8Encode(serializeEnvelope(committed));
      if (!bytesEqual(expected, actual)) {
        throw new Error('LOCAL_STATE_COMMIT_FAILED');
      }
      return committed;
    } finally {
      vaultWriteInProgress = false;
    }
  }
}
