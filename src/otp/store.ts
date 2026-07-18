export interface OtpStore {
  set(key: string, hashedOtp: string, ttlSeconds: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
}

// dev/test only -- real deployments use RedisOtpStore (redis-store.ts)
export class InMemoryOtpStore implements OtpStore {
  private entries = new Map<string, { value: string; expiresAt: number }>();

  async set(key: string, hashedOtp: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value: hashedOtp, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }
}
