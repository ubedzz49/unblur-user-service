export interface LogLevelClient {
  getLevel(service: string): Promise<string>;
  setLevel(service: string, level: string): Promise<string>;
  listServices(): string[];
}

const REQUEST_TIMEOUT_MS = 8000;

// talks to each service's own GET/POST /internal/log-level -- same "admin dashboard calls
// this service, this service makes the internal-token-gated call server-side" pattern as
// gateway-client.ts's route management, so the browser never sees the internal token.
// SERVICE_URLS_JSON is a flat { serviceName: baseUrl } map, one entry per backend service
// that exposes /internal/log-level -- kept here rather than duplicated per-service.
export class HttpLogLevelClient implements LogLevelClient {
  private readonly urls: Record<string, string>;

  constructor(
    urlsJson: string = process.env.SERVICE_URLS_JSON ?? "{}",
    private readonly internalToken: string = process.env.INTERNAL_SERVICE_TOKEN ?? "",
  ) {
    this.urls = JSON.parse(urlsJson || "{}");
  }

  listServices(): string[] {
    return Object.keys(this.urls);
  }

  private baseUrl(service: string): string {
    const url = this.urls[service];
    if (!url) throw new Error(`unknown service "${service}"`);
    return url;
  }

  async getLevel(service: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(new URL("/internal/log-level", this.baseUrl(service)), {
        headers: { "X-Internal-Service-Token": this.internalToken },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${service} returned ${res.status} fetching log level`);
      const body = (await res.json()) as { level: string };
      return body.level;
    } finally {
      clearTimeout(timeout);
    }
  }

  async setLevel(service: string, level: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(new URL("/internal/log-level", this.baseUrl(service)), {
        method: "POST",
        headers: { "content-type": "application/json", "X-Internal-Service-Token": this.internalToken },
        body: JSON.stringify({ level }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${service} returned ${res.status} setting log level`);
      }
      const body = (await res.json()) as { level: string };
      return body.level;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// test-only
export class FakeLogLevelClient implements LogLevelClient {
  public levels: Record<string, string> = { "user-service": "info" };

  listServices(): string[] {
    return Object.keys(this.levels);
  }

  async getLevel(service: string): Promise<string> {
    return this.levels[service] ?? "info";
  }

  async setLevel(service: string, level: string): Promise<string> {
    this.levels[service] = level;
    return level;
  }
}
