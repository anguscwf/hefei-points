import { huks } from '@kit.UniversalKeystoreKit';
import { BusinessError } from '@kit.BasicServicesKit';
import {
  assertP256Spki,
  base64urlEncode,
  normalizeEcdsaSignature
} from './Encoding';

const DEVICE_KEY_ALIAS: string = 'tangguan.s7.device-proof.p256.v1';

function storageProperty(): huks.HuksParam {
  return {
    tag: huks.HuksTag.HUKS_TAG_AUTH_STORAGE_LEVEL,
    value: huks.HuksAuthStorageLevel.HUKS_AUTH_STORAGE_LEVEL_ECE
  };
}

function lookupProperties(): Array<huks.HuksParam> {
  return [storageProperty()];
}

function generationProperties(): Array<huks.HuksParam> {
  return [
    {
      tag: huks.HuksTag.HUKS_TAG_ALGORITHM,
      value: huks.HuksKeyAlg.HUKS_ALG_ECC
    },
    {
      tag: huks.HuksTag.HUKS_TAG_KEY_SIZE,
      value: huks.HuksKeySize.HUKS_ECC_KEY_SIZE_256
    },
    {
      tag: huks.HuksTag.HUKS_TAG_PURPOSE,
      value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_SIGN
        | huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_VERIFY
    },
    {
      tag: huks.HuksTag.HUKS_TAG_DIGEST,
      value: huks.HuksKeyDigest.HUKS_DIGEST_SHA256
    },
    {
      tag: huks.HuksTag.HUKS_TAG_KEY_OVERRIDE,
      value: false
    },
    storageProperty()
  ];
}

function signingProperties(): Array<huks.HuksParam> {
  return [
    {
      tag: huks.HuksTag.HUKS_TAG_ALGORITHM,
      value: huks.HuksKeyAlg.HUKS_ALG_ECC
    },
    {
      tag: huks.HuksTag.HUKS_TAG_KEY_SIZE,
      value: huks.HuksKeySize.HUKS_ECC_KEY_SIZE_256
    },
    {
      tag: huks.HuksTag.HUKS_TAG_PURPOSE,
      value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_SIGN
    },
    {
      tag: huks.HuksTag.HUKS_TAG_DIGEST,
      value: huks.HuksKeyDigest.HUKS_DIGEST_SHA256
    },
    storageProperty()
  ];
}

export class DeviceIdentity {
  async exists(): Promise<boolean> {
    try {
      return await huks.hasKeyItem(DEVICE_KEY_ALIAS, { properties: lookupProperties() });
    } catch (_) {
      throw new Error('DEVICE_KEY_LOOKUP_FAILED');
    }
  }

  async create(): Promise<void> {
    if (await this.exists()) {
      throw new Error('DEVICE_KEY_ALREADY_EXISTS');
    }
    try {
      await huks.generateKeyItem(DEVICE_KEY_ALIAS, { properties: generationProperties() });
    } catch (error) {
      const businessError: BusinessError = error as BusinessError;
      if (businessError.code !== 12000017 || !await this.exists()) {
        throw new Error('DEVICE_KEY_CREATE_FAILED');
      }
    }
  }

  async publicKeyBase64url(): Promise<string> {
    if (!await this.exists()) {
      throw new Error('DEVICE_KEY_MISSING');
    }
    let result: huks.HuksReturnResult;
    try {
      result = await huks.exportKeyItem(DEVICE_KEY_ALIAS, { properties: lookupProperties() });
    } catch (_) {
      throw new Error('DEVICE_KEY_EXPORT_FAILED');
    }
    if (!result.outData) {
      throw new Error('DEVICE_KEY_EXPORT_FAILED');
    }
    assertP256Spki(result.outData);
    return base64urlEncode(result.outData);
  }

  async signBase64url(payload: Uint8Array): Promise<string> {
    if (payload.length < 1 || payload.length > 512 || !await this.exists()) {
      throw new Error('DEVICE_SIGNING_UNAVAILABLE');
    }
    const options: huks.HuksOptions = {
      properties: signingProperties(),
      inData: payload
    };
    let handle: number = -1;
    try {
      const session: huks.HuksSessionHandle = await huks.initSession(DEVICE_KEY_ALIAS, options);
      handle = session.handle;
      const result: huks.HuksReturnResult = await huks.finishSession(handle, options);
      handle = -1;
      if (!result.outData) {
        throw new Error('DEVICE_SIGNING_FAILED');
      }
      return base64urlEncode(normalizeEcdsaSignature(result.outData));
    } catch (error) {
      if (handle >= 0) {
        try {
          await huks.abortSession(handle, { properties: [] });
        } catch (_) {
          // Best effort only; the original stable failure remains authoritative.
        }
      }
      throw new Error('DEVICE_SIGNING_FAILED');
    }
  }
}
