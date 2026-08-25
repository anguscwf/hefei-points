const CANONICAL_HTTPS_ORIGIN: RegExp = /^https:\/\/(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function isCanonicalHttpsOrigin(value: string): boolean {
  if (!CANONICAL_HTTPS_ORIGIN.test(value)) {
    return false;
  }
  const hostname: string = value.substring('https://'.length);
  return !hostname.endsWith('.invalid')
    && !hostname.endsWith('.localhost')
    && !hostname.endsWith('.local')
    && !hostname.endsWith('.test');
}

export class ApiEnvironment {
  static readonly PROFILE: string = 'develop-blocked';
  static readonly NETWORK_ENABLED: boolean = false;
  static readonly API_ORIGIN: string = 'https://harmony-child.invalid';
  static readonly CONNECT_TIMEOUT_MS: number = 10000;
  static readonly READ_TIMEOUT_MS: number = 15000;

  static assertUsable(): void {
    if (!ApiEnvironment.NETWORK_ENABLED) {
      throw new Error('LOCAL_ENVIRONMENT_DISABLED');
    }
    if (!isCanonicalHttpsOrigin(ApiEnvironment.API_ORIGIN)) {
      throw new Error('LOCAL_ENVIRONMENT_INVALID');
    }
  }
}
