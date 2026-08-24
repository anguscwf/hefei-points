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
    if (!ApiEnvironment.API_ORIGIN.startsWith('https://')) {
      throw new Error('LOCAL_ENVIRONMENT_INVALID');
    }
  }
}
