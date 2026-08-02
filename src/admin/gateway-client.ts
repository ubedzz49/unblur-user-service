export interface RouteConfig {
  prefix: string;
  upstream: string;
}

export interface GatewayClient {
  getRoutes(): Promise<RouteConfig[]>;
  updateRoutes(routes: RouteConfig[]): Promise<RouteConfig[]>;
}

const REQUEST_TIMEOUT_MS = 3000;

// talks to gateway-core's own /internal/routes -- the one place in this project a backend
// service calls the gateway rather than the other way around. Never exposes the internal
// service token to the browser: the admin dashboard calls this service's own
// GET/POST /admin/gateway-routes (JWT-gated), which then makes this internal-token-gated call
// server-side.
export class HttpGatewayClient implements GatewayClient {
  constructor(
    private readonly baseUrl: string = process.env.GATEWAY_CORE_URL ?? "",
    private readonly internalToken: string = process.env.INTERNAL_SERVICE_TOKEN ?? "",
  ) {}

  async getRoutes(): Promise<RouteConfig[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL("/internal/routes", this.baseUrl);
      const res = await fetch(url, {
        headers: { "X-Internal-Service-Token": this.internalToken },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`gateway returned ${res.status} fetching routes`);
      return (await res.json()) as RouteConfig[];
    } finally {
      clearTimeout(timeout);
    }
  }

  async updateRoutes(routes: RouteConfig[]): Promise<RouteConfig[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL("/internal/routes", this.baseUrl);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Internal-Service-Token": this.internalToken },
        body: JSON.stringify(routes),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `gateway returned ${res.status} updating routes`);
      }
      return (await res.json()) as RouteConfig[];
    } finally {
      clearTimeout(timeout);
    }
  }
}

// test-only
export class FakeGatewayClient implements GatewayClient {
  public routes: RouteConfig[] = [{ prefix: "/users", upstream: "http://user-service" }];
  public updateCalls: RouteConfig[][] = [];

  async getRoutes(): Promise<RouteConfig[]> {
    return this.routes;
  }

  async updateRoutes(routes: RouteConfig[]): Promise<RouteConfig[]> {
    this.updateCalls.push(routes);
    this.routes = routes;
    return routes;
  }
}
