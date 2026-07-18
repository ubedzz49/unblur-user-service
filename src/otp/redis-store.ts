import { Redis } from "ioredis";
import { OtpStore } from "./store.js";

export class RedisOtpStore implements OtpStore {
  private client: Redis;

  constructor(client: Redis) {
    this.client = client;
  }

  async set(key: string, hashedOtp: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, hashedOtp, "EX", ttlSeconds);
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}

export function buildRedisClient(): Redis {
  return new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_AUTH_TOKEN,
    tls: process.env.REDIS_TLS === "true" ? {} : undefined,
  });
}
