import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "./app.js";
import { InMemoryOtpStore } from "./otp/store.js";
import { RecordingEmailSender } from "./email/sender.js";
import { InMemoryUserRepository } from "./users/repository.js";
import { InMemoryStatsRepository } from "./stats/repository.js";
import { InMemoryExpertiseRepository } from "./expertise/repository.js";
import { FakeMatchingClient, MatchingClient } from "./matching/client.js";
import { signAuthToken } from "./jwt.js";

describe("GET /healthz", () => {
  it("returns ok status", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("OTP auth flow", () => {
  const originalJwtSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalJwtSecret;
  });

  it("send -> verify -> returns a jwt", async () => {
    const app = buildApp();

    const sendRes = await app.inject({
      method: "POST",
      url: "/auth/otp/send",
      payload: { identifier: "+911234567890" },
    });
    expect(sendRes.statusCode).toBe(200);
    const { otp } = sendRes.json();
    expect(otp).toMatch(/^\d{6}$/);

    const verifyRes = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { identifier: "+911234567890", otp },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().token).toBeTypeOf("string");
  });

  it("rejects verify with wrong otp", async () => {
    const app = buildApp();
    await app.inject({ method: "POST", url: "/auth/otp/send", payload: { identifier: "+911111111111" } });

    const res = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { identifier: "+911111111111", otp: "000000" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects send with no identifier", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/auth/otp/send", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe("OTP via email", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  it("sends the otp by email instead of returning it, and verify still works", async () => {
    const otpStore = new InMemoryOtpStore();
    const emailSender = new RecordingEmailSender();
    const app = buildApp(otpStore, emailSender);

    const sendRes = await app.inject({
      method: "POST",
      url: "/auth/otp/send",
      payload: { identifier: "student@example.com" },
    });
    expect(sendRes.statusCode).toBe(200);
    expect(sendRes.json()).toEqual({ sent: true });
    expect(sendRes.json().otp).toBeUndefined();

    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0].to).toBe("student@example.com");
    const otp = emailSender.sent[0].text.match(/\d{6}/)?.[0];
    expect(otp).toMatch(/^\d{6}$/);

    const verifyRes = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { identifier: "student@example.com", otp },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().token).toBeTypeOf("string");
  });

  it("does not email a phone identifier", async () => {
    const emailSender = new RecordingEmailSender();
    const app = buildApp(new InMemoryOtpStore(), emailSender);

    await app.inject({ method: "POST", url: "/auth/otp/send", payload: { identifier: "+911234567890" } });

    expect(emailSender.sent).toHaveLength(0);
  });
});

describe("OTP verify links to a real user record", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  it("creates a user on first verify and reuses it on a second login", async () => {
    const userRepo = new InMemoryUserRepository();
    const otpStore = new InMemoryOtpStore();
    const app = buildApp(otpStore, new RecordingEmailSender(), userRepo);

    const send1 = await app.inject({ method: "POST", url: "/auth/otp/send", payload: { identifier: "+911234567890" } });
    const verify1 = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { identifier: "+911234567890", otp: send1.json().otp },
    });
    const token1 = verify1.json().token;
    // first verify creates the account -> flagged new (frontend routes to onboarding)
    expect(verify1.json().isNewUser).toBe(true);

    const send2 = await app.inject({ method: "POST", url: "/auth/otp/send", payload: { identifier: "+911234567890" } });
    const verify2 = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { identifier: "+911234567890", otp: send2.json().otp },
    });
    const token2 = verify2.json().token;
    // second verify is a returning login -> not new (frontend routes to home)
    expect(verify2.json().isNewUser).toBe(false);

    const me1 = await app.inject({ method: "GET", url: "/users/me", headers: { authorization: `Bearer ${token1}` } });
    const me2 = await app.inject({ method: "GET", url: "/users/me", headers: { authorization: `Bearer ${token2}` } });

    expect(me1.json().id).toBe(me2.json().id);
    expect(me1.json().phone).toBe("+911234567890");
  });
});

describe("GET /users/me", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  it("rejects with no token", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/users/me" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid token", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/users/me", headers: { authorization: "Bearer garbage" } });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /users/me", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  it("updates the provided fields and leaves the rest untouched", async () => {
    const userRepo = new InMemoryUserRepository();
    const app = buildApp(new InMemoryOtpStore(), new RecordingEmailSender(), userRepo);

    const { user } = await userRepo.findOrCreateByIdentifier("student@example.com", true);
    const token = signAuthToken(user.id);

    const res = await app.inject({
      method: "PATCH",
      url: "/users/me",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Asha", bio: "Maths tutor" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Asha");
    expect(res.json().bio).toBe("Maths tutor");
    expect(res.json().email).toBe("student@example.com");
  });

  it("rejects with no token", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "PATCH", url: "/users/me", payload: { name: "Asha" } });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /users/me/photo-upload-url", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  it("returns an upload url and a public url for an allowed content type", async () => {
    const userRepo = new InMemoryUserRepository();
    const app = buildApp(new InMemoryOtpStore(), new RecordingEmailSender(), userRepo);
    const { user } = await userRepo.findOrCreateByIdentifier("student@example.com", true);
    const token = signAuthToken(user.id);

    const res = await app.inject({
      method: "POST",
      url: "/users/me/photo-upload-url",
      headers: { authorization: `Bearer ${token}` },
      payload: { contentType: "image/png" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().uploadUrl).toBeTypeOf("string");
    expect(res.json().publicUrl).toBeTypeOf("string");
  });

  it("rejects an unsupported content type", async () => {
    const userRepo = new InMemoryUserRepository();
    const app = buildApp(new InMemoryOtpStore(), new RecordingEmailSender(), userRepo);
    const { user } = await userRepo.findOrCreateByIdentifier("student@example.com", true);
    const token = signAuthToken(user.id);

    const res = await app.inject({
      method: "POST",
      url: "/users/me/photo-upload-url",
      headers: { authorization: `Bearer ${token}` },
      payload: { contentType: "application/pdf" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects with no token", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/users/me/photo-upload-url",
      payload: { contentType: "image/png" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("expertise endpoints", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  it("lists the available expertise options with no auth required", async () => {
    const app = buildApp(new InMemoryOtpStore(), new RecordingEmailSender(), new InMemoryUserRepository());
    const res = await app.inject({ method: "GET", url: "/expertise-options" });

    expect(res.statusCode).toBe(200);
    expect(res.json().some((o: { slug: string }) => o.slug === "maths")).toBe(true);
  });

  it("adds an expertise entry for the current user and lists it back", async () => {
    const userRepo = new InMemoryUserRepository();
    const expertiseRepo = new InMemoryExpertiseRepository();
    const app = buildApp(
      new InMemoryOtpStore(),
      new RecordingEmailSender(),
      userRepo,
      undefined,
      expertiseRepo,
    );
    const { user } = await userRepo.findOrCreateByIdentifier("student@example.com", true);
    const token = signAuthToken(user.id);

    const addRes = await app.inject({
      method: "POST",
      url: "/users/me/expertise",
      headers: { authorization: `Bearer ${token}` },
      payload: { expertiseTypeId: "type-maths", expertiseLevelId: "level-class-12" },
    });
    expect(addRes.statusCode).toBe(201);

    const listRes = await app.inject({
      method: "GET",
      url: "/users/me/expertise",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toHaveLength(1);
    expect(listRes.json()[0].expertiseTypeName).toBe("Maths");
  });

  it("rejects adding the same expertise twice with a 409", async () => {
    const userRepo = new InMemoryUserRepository();
    const expertiseRepo = new InMemoryExpertiseRepository();
    const app = buildApp(
      new InMemoryOtpStore(),
      new RecordingEmailSender(),
      userRepo,
      undefined,
      expertiseRepo,
    );
    const { user } = await userRepo.findOrCreateByIdentifier("student@example.com", true);
    const token = signAuthToken(user.id);
    const payload = { expertiseTypeId: "type-maths", expertiseLevelId: "level-class-12" };

    await app.inject({
      method: "POST",
      url: "/users/me/expertise",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    const secondRes = await app.inject({
      method: "POST",
      url: "/users/me/expertise",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

    expect(secondRes.statusCode).toBe(409);
  });

  it("removes an expertise entry", async () => {
    const userRepo = new InMemoryUserRepository();
    const expertiseRepo = new InMemoryExpertiseRepository();
    const app = buildApp(
      new InMemoryOtpStore(),
      new RecordingEmailSender(),
      userRepo,
      undefined,
      expertiseRepo,
    );
    const { user } = await userRepo.findOrCreateByIdentifier("student@example.com", true);
    const token = signAuthToken(user.id);

    const addRes = await app.inject({
      method: "POST",
      url: "/users/me/expertise",
      headers: { authorization: `Bearer ${token}` },
      payload: { expertiseTypeId: "type-maths", expertiseLevelId: "level-class-12" },
    });
    const entryId = addRes.json().id;

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/users/me/expertise/${entryId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleteRes.statusCode).toBe(204);

    const listRes = await app.inject({
      method: "GET",
      url: "/users/me/expertise",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.json()).toHaveLength(0);
  });

  it("rejects with no token", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/users/me/expertise" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /expertise-options/custom", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  function buildAuthedApp(matchingClient: MatchingClient = new FakeMatchingClient()) {
    const userRepo = new InMemoryUserRepository();
    const expertiseRepo = new InMemoryExpertiseRepository();
    const app = buildApp(
      new InMemoryOtpStore(),
      new RecordingEmailSender(),
      userRepo,
      undefined,
      expertiseRepo,
      matchingClient,
    );
    return { app, userRepo };
  }

  async function authHeader(userRepo: InMemoryUserRepository) {
    const { user } = await userRepo.findOrCreateByIdentifier("student@example.com", true);
    return `Bearer ${signAuthToken(user.id)}`;
  }

  it("creates a brand-new custom subject and level", async () => {
    const { app, userRepo } = buildAuthedApp();
    const authorization = await authHeader(userRepo);

    const res = await app.inject({
      method: "POST",
      url: "/expertise-options/custom",
      headers: { authorization },
      payload: { subjectName: "DSA", levelName: "Beginner" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.typeName).toBe("DSA");
    expect(body.levelName).toBe("Beginner");
    expect(body.expertiseTypeId).toBeTruthy();
    expect(body.expertiseLevelId).toBeTruthy();
  });

  it("reuses an existing custom subject by slug on a second call", async () => {
    const { app, userRepo } = buildAuthedApp();
    const authorization = await authHeader(userRepo);

    const first = await app.inject({
      method: "POST",
      url: "/expertise-options/custom",
      headers: { authorization },
      payload: { subjectName: "DSA", levelName: "Beginner" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/expertise-options/custom",
      headers: { authorization },
      payload: { subjectName: "dsa", levelName: "beginner" },
    });

    expect(second.json().expertiseTypeId).toBe(first.json().expertiseTypeId);
    expect(second.json().expertiseLevelId).toBe(first.json().expertiseLevelId);
  });

  it("creates and reuses 'General' when levelName is omitted", async () => {
    const { app, userRepo } = buildAuthedApp();
    const authorization = await authHeader(userRepo);

    const res = await app.inject({
      method: "POST",
      url: "/expertise-options/custom",
      headers: { authorization },
      payload: { subjectName: "Underwater Basket Weaving" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().levelName).toBe("General");
  });

  it("rejects an empty subjectName with a 400", async () => {
    const { app, userRepo } = buildAuthedApp();
    const authorization = await authHeader(userRepo);

    const res = await app.inject({
      method: "POST",
      url: "/expertise-options/custom",
      headers: { authorization },
      payload: { subjectName: "   " },
    });

    expect(res.statusCode).toBe(400);
  });

  it("still returns 201 when the embed call fails", async () => {
    class ThrowingMatchingClient implements MatchingClient {
      async embedNode(): Promise<void> {
        throw new Error("matching service unreachable");
      }
    }
    const { app, userRepo } = buildAuthedApp(new ThrowingMatchingClient());
    const authorization = await authHeader(userRepo);

    const res = await app.inject({
      method: "POST",
      url: "/expertise-options/custom",
      headers: { authorization },
      payload: { subjectName: "DSA" },
    });

    expect(res.statusCode).toBe(201);
  });

  it("rejects with no token", async () => {
    const { app } = buildAuthedApp();
    const res = await app.inject({
      method: "POST",
      url: "/expertise-options/custom",
      payload: { subjectName: "DSA" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /users/me/stats", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  function build() {
    const userRepo = new InMemoryUserRepository();
    const statsRepo = new InMemoryStatsRepository();
    const app = buildApp(
      new InMemoryOtpStore(),
      new RecordingEmailSender(),
      userRepo,
      undefined,
      new InMemoryExpertiseRepository(),
      new FakeMatchingClient(),
      statsRepo,
    );
    return { app, userRepo, statsRepo };
  }

  it("returns zeros for a brand-new user", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("student@example.com", true);
    await statsRepo.initializeForUser(user.id);
    const token = signAuthToken(user.id);

    const res = await app.inject({
      method: "GET",
      url: "/users/me/stats",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      minutesResolved: 0,
      avgRating: 0,
      ratingCount: 0,
      minutesListener: 0,
      updatedAt: expect.any(String),
    });
  });

  it("returns 404 rather than crashing if a stats row is somehow missing", async () => {
    const { app, userRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("student@example.com", true);
    const token = signAuthToken(user.id);

    const res = await app.inject({
      method: "GET",
      url: "/users/me/stats",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "stats not found" });
  });

  it("rejects with no token", async () => {
    const { app } = build();
    const res = await app.inject({ method: "GET", url: "/users/me/stats" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /users/:id/public", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  function build() {
    const userRepo = new InMemoryUserRepository();
    const statsRepo = new InMemoryStatsRepository();
    const app = buildApp(
      new InMemoryOtpStore(),
      new RecordingEmailSender(),
      userRepo,
      undefined,
      new InMemoryExpertiseRepository(),
      new FakeMatchingClient(),
      statsRepo,
    );
    return { app, userRepo, statsRepo };
  }

  it("returns the public view including bio and expertise for another user", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user: caller } = await userRepo.findOrCreateByIdentifier("caller@example.com", true);
    const { user: target } = await userRepo.findOrCreateByIdentifier("target@example.com", true);
    await statsRepo.initializeForUser(target.id);
    await userRepo.updateProfile(target.id, {
      name: "Asha",
      photoUrl: "https://cdn/asha.png",
      bio: "I help with CAT quant",
    });
    const token = signAuthToken(caller.id);

    const res = await app.inject({
      method: "GET",
      url: `/users/${target.id}/public`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      id: target.id,
      name: "Asha",
      photoUrl: "https://cdn/asha.png",
      bio: "I help with CAT quant",
      expertise: [],
      stats: { minutesResolved: 0, avgRating: 0, ratingCount: 0, minutesListener: 0 },
    });
    // privacy boundary -- these must never appear in the public view
    expect(Object.keys(body)).not.toContain("email");
    expect(Object.keys(body)).not.toContain("phone");
  });

  it("returns bio: null when the target user has no bio set", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user: caller } = await userRepo.findOrCreateByIdentifier("caller@example.com", true);
    const { user: target } = await userRepo.findOrCreateByIdentifier("target@example.com", true);
    await statsRepo.initializeForUser(target.id);
    const token = signAuthToken(caller.id);

    const res = await app.inject({
      method: "GET",
      url: `/users/${target.id}/public`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().bio).toBeNull();
  });

  it("maps the target user's tagged expertise to the display shape", async () => {
    const userRepo = new InMemoryUserRepository();
    const statsRepo = new InMemoryStatsRepository();
    const expertiseRepo = new InMemoryExpertiseRepository();
    const app = buildApp(
      new InMemoryOtpStore(),
      new RecordingEmailSender(),
      userRepo,
      undefined,
      expertiseRepo,
      new FakeMatchingClient(),
      statsRepo,
    );
    const { user: caller } = await userRepo.findOrCreateByIdentifier("caller@example.com", true);
    const { user: target } = await userRepo.findOrCreateByIdentifier("target@example.com", true);
    await statsRepo.initializeForUser(target.id);
    const entry = await expertiseRepo.addForUser(target.id, "type-maths", "level-class-12");
    const token = signAuthToken(caller.id);

    const res = await app.inject({
      method: "GET",
      url: `/users/${target.id}/public`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().expertise).toEqual([
      {
        id: entry.id,
        expertiseTypeName: "Maths",
        expertiseLevelName: "NCERT Class 12",
      },
    ]);
  });

  it("returns 404 for a nonexistent but well-formed id", async () => {
    const { app, userRepo } = build();
    const { user: caller } = await userRepo.findOrCreateByIdentifier("caller@example.com", true);
    const token = signAuthToken(caller.id);

    const res = await app.inject({
      method: "GET",
      url: "/users/00000000-0000-4000-8000-000000000000/public",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for a malformed id", async () => {
    const { app, userRepo } = build();
    const { user: caller } = await userRepo.findOrCreateByIdentifier("caller@example.com", true);
    const token = signAuthToken(caller.id);

    const res = await app.inject({
      method: "GET",
      url: "/users/not-a-uuid/public",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects with no token", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "GET",
      url: "/users/00000000-0000-4000-8000-000000000000/public",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /internal/users/:id/stats/increment-minutes-resolved", () => {
  const originalInternalToken = process.env.INTERNAL_SERVICE_TOKEN;

  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
    process.env.INTERNAL_SERVICE_TOKEN = "test-internal-secret";
  });

  afterAll(() => {
    process.env.INTERNAL_SERVICE_TOKEN = originalInternalToken;
  });

  function build() {
    const userRepo = new InMemoryUserRepository();
    const statsRepo = new InMemoryStatsRepository();
    const app = buildApp(
      new InMemoryOtpStore(),
      new RecordingEmailSender(),
      userRepo,
      undefined,
      new InMemoryExpertiseRepository(),
      new FakeMatchingClient(),
      statsRepo,
    );
    return { app, userRepo, statsRepo };
  }

  it("succeeds with the correct internal token and increments correctly", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("resolver@example.com", true);
    await statsRepo.initializeForUser(user.id);

    const res = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/increment-minutes-resolved`,
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { minutes: 30 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ minutesResolved: 30 });

    const again = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/increment-minutes-resolved`,
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { minutes: 15 },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ minutesResolved: 45 });
  });

  it("rejects a request with no internal token header", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("resolver@example.com", true);
    await statsRepo.initializeForUser(user.id);

    const res = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/increment-minutes-resolved`,
      payload: { minutes: 30 },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid internal service token" });
  });

  it("rejects a request with the wrong internal token value", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("resolver@example.com", true);
    await statsRepo.initializeForUser(user.id);

    const res = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/increment-minutes-resolved`,
      headers: { "x-internal-service-token": "totally-wrong" },
      payload: { minutes: 30 },
    });

    expect(res.statusCode).toBe(401);
  });

  // the core security property: a real, validly-signed end-user jwt must not work here --
  // this endpoint is service-to-service only, no user has a legitimate reason to call it
  it("rejects a request using a valid user JWT instead of the internal token", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("resolver@example.com", true);
    await statsRepo.initializeForUser(user.id);
    const userToken = signAuthToken(user.id);

    const res = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/increment-minutes-resolved`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { minutes: 30 },
    });

    expect(res.statusCode).toBe(401);
    const stats = await statsRepo.findByUserId(user.id);
    expect(stats?.minutesResolved).toBe(0);
  });

  it("rejects a negative minutes value", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("resolver@example.com", true);
    await statsRepo.initializeForUser(user.id);

    const res = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/increment-minutes-resolved`,
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { minutes: -5 },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects a zero minutes value", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("resolver@example.com", true);
    await statsRepo.initializeForUser(user.id);

    const res = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/increment-minutes-resolved`,
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { minutes: 0 },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-integer minutes value", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("resolver@example.com", true);
    await statsRepo.initializeForUser(user.id);

    const res = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/increment-minutes-resolved`,
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { minutes: 12.5 },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-numeric minutes value", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("resolver@example.com", true);
    await statsRepo.initializeForUser(user.id);

    const res = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/increment-minutes-resolved`,
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { minutes: "thirty" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects an unreasonably large minutes value", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("resolver@example.com", true);
    await statsRepo.initializeForUser(user.id);

    const res = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/increment-minutes-resolved`,
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { minutes: 1441 },
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for a nonexistent target user id even with a valid internal token", async () => {
    const { app } = build();

    const res = await app.inject({
      method: "POST",
      url: "/internal/users/00000000-0000-4000-8000-000000000000/stats/increment-minutes-resolved",
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { minutes: 30 },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for a malformed target user id", async () => {
    const { app } = build();

    const res = await app.inject({
      method: "POST",
      url: "/internal/users/not-a-uuid/stats/increment-minutes-resolved",
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { minutes: 30 },
    });

    expect(res.statusCode).toBe(400);
  });
});
