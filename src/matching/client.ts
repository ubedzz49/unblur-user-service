import { logger } from "../logger.js";

export interface MatchingClient {
  embedNode(expertiseTypeId: string, expertiseLevelId: string, label: string): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 2000;

// Calls the Matching Service's /match/embed-node so a freshly created user-submitted taxonomy
// node participates in semantic matching immediately, instead of waiting for the next manual
// backfill run. Same graceful-degradation contract as doubt-service's HttpMatchingClient: this
// is an enhancement, never a hard dependency -- any error or timeout here is logged and
// swallowed rather than thrown, so the caller's request still succeeds.
export class HttpMatchingClient implements MatchingClient {
  private baseUrl: string;

  constructor(baseUrl = process.env.MATCHING_SERVICE_URL ?? "") {
    this.baseUrl = baseUrl;
  }

  async embedNode(expertiseTypeId: string, expertiseLevelId: string, label: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const url = new URL("/match/embed-node", this.baseUrl);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expertiseTypeId, expertiseLevelId, label }),
        signal: controller.signal,
      });

      if (!res.ok) {
        logger.warn(
          { expertiseTypeId, expertiseLevelId, status: res.status },
          "matching service embed-node returned non-ok response",
        );
      }
    } catch (err) {
      logger.warn({ expertiseTypeId, expertiseLevelId, err }, "matching service embed-node call failed or timed out");
    } finally {
      clearTimeout(timeout);
    }
  }
}

// test-only
export class FakeMatchingClient implements MatchingClient {
  public calls: Array<{ expertiseTypeId: string; expertiseLevelId: string; label: string }> = [];

  async embedNode(expertiseTypeId: string, expertiseLevelId: string, label: string): Promise<void> {
    this.calls.push({ expertiseTypeId, expertiseLevelId, label });
  }
}
