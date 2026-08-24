import { asset } from '@kit.AssetStoreKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { bytesEqual, utf8Decode, utf8Encode } from './Encoding';
import {
  copyPointRequestIntent,
  parsePointRequestIntent,
  PointRequestIntent,
  serializePointRequestIntent
} from '../session/PointRequestIntent';

const POINT_INTENT_ALIAS: string = 'tangguan.s8.point-request-intent.v1';
const MAX_POINT_INTENT_BYTES: number = 1024;
let pointVaultWriteInProgress: boolean = false;

function aliasBytes(): Uint8Array {
  return utf8Encode(POINT_INTENT_ALIAS);
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

export class PointRequestVault {
  async load(): Promise<PointRequestIntent | null> {
    let result: Array<asset.AssetMap>;
    try {
      result = await asset.query(loadQuery());
    } catch (error) {
      const businessError: BusinessError = error as BusinessError;
      if (businessError.code === 24000002) {
        return null;
      }
      throw new Error('LOCAL_POINT_INTENT_LOAD_FAILED');
    }
    if (result.length === 0) {
      return null;
    }
    if (result.length !== 1) {
      throw new Error('LOCAL_POINT_INTENT_CORRUPT');
    }
    const secret: Uint8Array = result[0].get(asset.Tag.SECRET) as Uint8Array;
    if (!secret || secret.length < 2 || secret.length > MAX_POINT_INTENT_BYTES) {
      throw new Error('LOCAL_POINT_INTENT_CORRUPT');
    }
    return parsePointRequestIntent(utf8Decode(secret));
  }

  async saveVerified(input: PointRequestIntent): Promise<PointRequestIntent> {
    if (pointVaultWriteInProgress) {
      throw new Error('LOCAL_POINT_INTENT_CONFLICT');
    }
    pointVaultWriteInProgress = true;
    try {
      const current: PointRequestIntent | null = await this.load();
      if ((current === null && input.revision !== 0)
          || (current !== null && current.revision !== input.revision)) {
        throw new Error('LOCAL_POINT_INTENT_CONFLICT');
      }
      const next: PointRequestIntent = copyPointRequestIntent(input);
      next.revision += 1;
      const secret: Uint8Array = utf8Encode(serializePointRequestIntent(next));
      if (secret.length > MAX_POINT_INTENT_BYTES) {
        throw new Error('LOCAL_POINT_INTENT_TOO_LARGE');
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
          throw new Error('LOCAL_POINT_INTENT_COMMIT_FAILED');
        }
      } else {
        const update: asset.AssetMap = new Map();
        update.set(asset.Tag.SECRET, secret);
        try {
          await asset.update(aliasQuery(), update);
        } catch (_) {
          throw new Error('LOCAL_POINT_INTENT_COMMIT_FAILED');
        }
      }
      const committed: PointRequestIntent | null = await this.load();
      if (committed === null) {
        throw new Error('LOCAL_POINT_INTENT_COMMIT_FAILED');
      }
      const expected: Uint8Array = utf8Encode(serializePointRequestIntent(next));
      const actual: Uint8Array = utf8Encode(serializePointRequestIntent(committed));
      if (!bytesEqual(expected, actual)) {
        throw new Error('LOCAL_POINT_INTENT_COMMIT_FAILED');
      }
      return committed;
    } finally {
      pointVaultWriteInProgress = false;
    }
  }
}
