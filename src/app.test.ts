import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "./app.js";
import { InMemoryOtpStore } from "./otp/store.js";
import { RecordingEmailSender } from "./email/sender.js";
import { InMemoryUserRepository } from "./users/repository.js";
import { InMemoryStatsRepository } from "./stats/repository.js";
import { InMemoryExpertiseRepository } from "./expertise/repository.js";
import { FakeMatchingClient, MatchingClient } from "./matching/client.js";
import { signAuthToken } from "./jwt.js";
import { FakeGatewayClient } from "./admin/gateway-client.js";

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

  it("rejects otp verify for a blocked user, without issuing a token", async () => {
    const userRepo = new InMemoryUserRepository();
    await userRepo.findOrCreateByIdentifier("+919999999999", false);
    // InMemoryUserRepository's identifier map isn't email-specific like the real Postgres
    // column lookup is, so blockByEmail works against this phone identifier too here -- used
    // purely so the otp can be read directly off the send response (email identifiers never
    // include it, see the "OTP via email" describe block above)
    await userRepo.blockByEmail("+919999999999");
    const otpStore = new InMemoryOtpStore();
    const app = buildApp(otpStore, new RecordingEmailSender(), userRepo);

    const send = await app.inject({ method: "POST", url: "/auth/otp/send", payload: { identifier: "+919999999999" } });
    const verify = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { identifier: "+919999999999", otp: send.json().otp },
    });

    expect(verify.statusCode).toBe(403);
    expect(verify.json()).toEqual({ error: "this account has been blocked" });
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

  // regression: real browsers/fetch clients (including our own frontend's request() helper)
  // send Content-Type: application/json on every request regardless of whether there's a body --
  // Fastify's default JSON parser rejects an empty body when that header is present, which broke
  // every real DELETE call even though it worked fine via curl without the header
  it("accepts an empty body with Content-Type: application/json set (real client behavior)", async () => {
    const userRepo = new InMemoryUserRepository();
    const expertiseRepo = new InMemoryExpertiseRepository();
    const app = buildApp(
      new InMemoryOtpStore(),
      new RecordingEmailSender(),
      userRepo,
      undefined,
      expertiseRepo,
    );
    const { user } = await userRepo.findOrCreateByIdentifier("student2@example.com", true);
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
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: "",
    });
    expect(deleteRes.statusCode).toBe(204);
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
      gdPoints: 0,
      updatedAt: expect.any(String),
      eligibility: { canHostSeminar: false, canOrganizeGD: false, canAttendGD: false },
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

  it("canHostSeminar is true right at the 300 minutes / 3.5 rating threshold (inclusive)", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("student@example.com", true);
    await statsRepo.initializeForUser(user.id);
    await statsRepo.incrementMinutesResolved(user.id, 300);
    // land avgRating exactly on 3.5: (3+4)/2 = 3.5
    await statsRepo.recordRating(user.id, 3);
    await statsRepo.recordRating(user.id, 4);
    const token = signAuthToken(user.id);

    const res = await app.inject({
      method: "GET",
      url: "/users/me/stats",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.json().eligibility.canHostSeminar).toBe(true);
  });

  it("canHostSeminar is false one minute below the 300 threshold", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("student@example.com", true);
    await statsRepo.initializeForUser(user.id);
    await statsRepo.incrementMinutesResolved(user.id, 299);
    await statsRepo.recordRating(user.id, 5);
    const token = signAuthToken(user.id);

    const res = await app.inject({
      method: "GET",
      url: "/users/me/stats",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.json().eligibility.canHostSeminar).toBe(false);
  });

  it("canOrganizeGD is true at exactly 100 minutes resolved and false at 99", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user: atThreshold } = await userRepo.findOrCreateByIdentifier("at-threshold@example.com", true);
    await statsRepo.initializeForUser(atThreshold.id);
    await statsRepo.incrementMinutesResolved(atThreshold.id, 100);

    const { user: belowThreshold } = await userRepo.findOrCreateByIdentifier("below-threshold@example.com", true);
    await statsRepo.initializeForUser(belowThreshold.id);
    await statsRepo.incrementMinutesResolved(belowThreshold.id, 99);

    const atRes = await app.inject({
      method: "GET",
      url: "/users/me/stats",
      headers: { authorization: `Bearer ${signAuthToken(atThreshold.id)}` },
    });
    const belowRes = await app.inject({
      method: "GET",
      url: "/users/me/stats",
      headers: { authorization: `Bearer ${signAuthToken(belowThreshold.id)}` },
    });

    expect(atRes.json().eligibility.canOrganizeGD).toBe(true);
    expect(belowRes.json().eligibility.canOrganizeGD).toBe(false);
  });

  it("canAttendGD is true at exactly 50 minutesListener and false at 49", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user: atThreshold } = await userRepo.findOrCreateByIdentifier("at-listener-threshold@example.com", true);
    await statsRepo.initializeForUser(atThreshold.id);
    statsRepo.seedMinutesListener(atThreshold.id, 50);

    const { user: belowThreshold } = await userRepo.findOrCreateByIdentifier(
      "below-listener-threshold@example.com",
      true,
    );
    await statsRepo.initializeForUser(belowThreshold.id);
    statsRepo.seedMinutesListener(belowThreshold.id, 49);

    const atRes = await app.inject({
      method: "GET",
      url: "/users/me/stats",
      headers: { authorization: `Bearer ${signAuthToken(atThreshold.id)}` },
    });
    const belowRes = await app.inject({
      method: "GET",
      url: "/users/me/stats",
      headers: { authorization: `Bearer ${signAuthToken(belowThreshold.id)}` },
    });

    expect(atRes.json().eligibility.canAttendGD).toBe(true);
    expect(belowRes.json().eligibility.canAttendGD).toBe(false);
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
      stats: {
        minutesResolved: 0,
        avgRating: 0,
        ratingCount: 0,
        minutesListener: 0,
        gdPoints: 0,
        eligibility: { canHostSeminar: false, canOrganizeGD: false, canAttendGD: false },
      },
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

describe("POST /internal/users/bulk", () => {
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
    const app = buildApp(
      new InMemoryOtpStore(),
      new RecordingEmailSender(),
      userRepo,
      undefined,
      new InMemoryExpertiseRepository(),
      new FakeMatchingClient(),
      new InMemoryStatsRepository(),
    );
    return { app, userRepo };
  }

  it("returns profile + the ai-notes toggle for each found user, ignoring unknown ids", async () => {
    const { app, userRepo } = build();
    const { user: enabled } = await userRepo.findOrCreateByIdentifier("poster@example.com", true);
    await userRepo.updateProfile(enabled.id, { name: "Poster", aiNotesAndTranscriptsEnabled: true });
    const { user: disabled } = await userRepo.findOrCreateByIdentifier("resolver@example.com", true);
    await userRepo.updateProfile(disabled.id, { name: "Resolver" });

    const res = await app.inject({
      method: "POST",
      url: "/internal/users/bulk",
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { userIds: [enabled.id, disabled.id, "00000000-0000-0000-0000-000000000000"] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      users: [
        { id: enabled.id, email: "poster@example.com", name: "Poster", aiNotesAndTranscriptsEnabled: true },
        { id: disabled.id, email: "resolver@example.com", name: "Resolver", aiNotesAndTranscriptsEnabled: false },
      ],
    });
  });

  it("rejects a request with no internal token header", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/internal/users/bulk",
      payload: { userIds: [] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a non-uuid entry in userIds", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/internal/users/bulk",
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { userIds: ["not-a-uuid"] },
    });
    expect(res.statusCode).toBe(400);
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

describe("GET /internal/users/:id/eligibility", () => {
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
    const app = buildApp(new InMemoryOtpStore(), new RecordingEmailSender(), userRepo, undefined, new InMemoryExpertiseRepository(), new FakeMatchingClient(), statsRepo);
    return { app, userRepo, statsRepo };
  }

  it("rejects without a valid internal token", async () => {
    const { app } = build();
    const res = await app.inject({ method: "GET", url: "/internal/users/00000000-0000-4000-8000-000000000000/eligibility" });
    expect(res.statusCode).toBe(401);
  });

  it("returns eligibility for an arbitrary user id, no caller JWT required", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("host@example.com", true);
    await statsRepo.initializeForUser(user.id);
    await statsRepo.incrementMinutesResolved(user.id, 300);
    await statsRepo.recordRating(user.id, 4);

    const res = await app.inject({
      method: "GET",
      url: `/internal/users/${user.id}/eligibility`,
      headers: { "x-internal-service-token": "test-internal-secret" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().canHostSeminar).toBe(true);
  });

  it("404s for a user with no stats row", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/users/00000000-0000-4000-8000-000000000000/eligibility",
      headers: { "x-internal-service-token": "test-internal-secret" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /internal/users/:id/stats/increment-minutes-listener", () => {
  const originalInternalToken = process.env.INTERNAL_SERVICE_TOKEN;
  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
    process.env.INTERNAL_SERVICE_TOKEN = "test-internal-secret";
  });
  afterAll(() => {
    process.env.INTERNAL_SERVICE_TOKEN = originalInternalToken;
  });

  it("increments minutesListener atomically", async () => {
    const userRepo = new InMemoryUserRepository();
    const statsRepo = new InMemoryStatsRepository();
    const app = buildApp(new InMemoryOtpStore(), new RecordingEmailSender(), userRepo, undefined, new InMemoryExpertiseRepository(), new FakeMatchingClient(), statsRepo);
    const { user } = await userRepo.findOrCreateByIdentifier("listener@example.com", true);
    await statsRepo.initializeForUser(user.id);

    const res = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/increment-minutes-listener`,
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { minutes: 50 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ minutesListener: 50 });
  });
});

describe("POST /internal/users/:id/stats/increment-gd-points", () => {
  const originalInternalToken = process.env.INTERNAL_SERVICE_TOKEN;
  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
    process.env.INTERNAL_SERVICE_TOKEN = "test-internal-secret";
  });
  afterAll(() => {
    process.env.INTERNAL_SERVICE_TOKEN = originalInternalToken;
  });

  it("increments gdPoints atomically", async () => {
    const userRepo = new InMemoryUserRepository();
    const statsRepo = new InMemoryStatsRepository();
    const app = buildApp(new InMemoryOtpStore(), new RecordingEmailSender(), userRepo, undefined, new InMemoryExpertiseRepository(), new FakeMatchingClient(), statsRepo);
    const { user } = await userRepo.findOrCreateByIdentifier("speaker@example.com", true);
    await statsRepo.initializeForUser(user.id);

    const res = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/increment-gd-points`,
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { points: 15 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ gdPoints: 15 });
  });
});

describe("POST /internal/users/:id/stats/record-rating", () => {
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

  it("succeeds with the correct internal token and computes the running average", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("resolver@example.com", true);
    await statsRepo.initializeForUser(user.id);

    const first = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/record-rating`,
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { rating: 5 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ avgRating: 5, ratingCount: 1 });

    // 5 then 3 -- average must land on exactly 4, not some rounding artifact
    const second = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/record-rating`,
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { rating: 3 },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ avgRating: 4, ratingCount: 2 });
  });

  it("rejects a request with no internal token header", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("resolver@example.com", true);
    await statsRepo.initializeForUser(user.id);

    const res = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/record-rating`,
      payload: { rating: 4 },
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
      url: `/internal/users/${user.id}/stats/record-rating`,
      headers: { "x-internal-service-token": "totally-wrong" },
      payload: { rating: 4 },
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
      url: `/internal/users/${user.id}/stats/record-rating`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { rating: 4 },
    });

    expect(res.statusCode).toBe(401);
    const stats = await statsRepo.findByUserId(user.id);
    expect(stats?.ratingCount).toBe(0);
  });

  it("rejects a rating of 0", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("resolver@example.com", true);
    await statsRepo.initializeForUser(user.id);

    const res = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/record-rating`,
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { rating: 0 },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects a negative rating", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("resolver@example.com", true);
    await statsRepo.initializeForUser(user.id);

    const res = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/record-rating`,
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { rating: -1 },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects a rating above 5", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("resolver@example.com", true);
    await statsRepo.initializeForUser(user.id);

    const res = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/record-rating`,
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { rating: 6 },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-integer rating", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("resolver@example.com", true);
    await statsRepo.initializeForUser(user.id);

    const res = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/record-rating`,
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { rating: 3.5 },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-numeric rating", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("resolver@example.com", true);
    await statsRepo.initializeForUser(user.id);

    const res = await app.inject({
      method: "POST",
      url: `/internal/users/${user.id}/stats/record-rating`,
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { rating: "five" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for a nonexistent target user id even with a valid internal token", async () => {
    const { app } = build();

    const res = await app.inject({
      method: "POST",
      url: "/internal/users/00000000-0000-4000-8000-000000000000/stats/record-rating",
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { rating: 4 },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for a malformed target user id", async () => {
    const { app } = build();

    const res = await app.inject({
      method: "POST",
      url: "/internal/users/not-a-uuid/stats/record-rating",
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { rating: 4 },
    });

    expect(res.statusCode).toBe(400);
  });

  it("two concurrent rating submissions both land -- proves it's atomic, not read-then-write", async () => {
    const { app, userRepo, statsRepo } = build();
    const { user } = await userRepo.findOrCreateByIdentifier("resolver@example.com", true);
    await statsRepo.initializeForUser(user.id);

    // fire both without awaiting one before the other -- a read-then-write implementation
    // could have one submission read the pre-update state and clobber the other's write
    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/internal/users/${user.id}/stats/record-rating`,
        headers: { "x-internal-service-token": "test-internal-secret" },
        payload: { rating: 5 },
      }),
      app.inject({
        method: "POST",
        url: `/internal/users/${user.id}/stats/record-rating`,
        headers: { "x-internal-service-token": "test-internal-secret" },
        payload: { rating: 3 },
      }),
    ]);

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const stats = await statsRepo.findByUserId(user.id);
    // both submissions must have landed -- ratingCount reflects both, and the average is
    // mathematically correct for 5 and 3 having both been recorded (average of 4), regardless
    // of which one the event loop happened to apply first
    expect(stats?.ratingCount).toBe(2);
    expect(stats?.avgRating).toBe(4);
  });
});

describe("admin endpoints", () => {
  const originalJwtSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = "test-secret";
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalJwtSecret;
  });

  function adminToken() {
    return signAuthToken("admin", "admin");
  }

  describe("GET /admin/users", () => {
    it("401s with no token", async () => {
      const app = buildApp();
      const res = await app.inject({ method: "GET", url: "/admin/users" });
      expect(res.statusCode).toBe(401);
    });

    it("403s a non-admin token", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/admin/users",
        headers: { authorization: `Bearer ${signAuthToken("some-real-user-id")}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("lists users for an admin token", async () => {
      const userRepo = new InMemoryUserRepository();
      await userRepo.findOrCreateByIdentifier("a@example.com", true);
      await userRepo.findOrCreateByIdentifier("b@example.com", true);
      const app = buildApp(undefined, undefined, userRepo);

      const res = await app.inject({
        method: "GET",
        url: "/admin/users",
        headers: { authorization: `Bearer ${adminToken()}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(2);
    });
  });

  describe("POST /admin/users/block and /unblock", () => {
    it("blocks a user by email, then unblocks them", async () => {
      const userRepo = new InMemoryUserRepository();
      await userRepo.findOrCreateByIdentifier("target@example.com", true);
      const app = buildApp(undefined, undefined, userRepo);

      const blockRes = await app.inject({
        method: "POST",
        url: "/admin/users/block",
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { email: "target@example.com" },
      });
      expect(blockRes.statusCode).toBe(200);
      expect(blockRes.json().blockedAt).toBeTruthy();

      const unblockRes = await app.inject({
        method: "POST",
        url: "/admin/users/unblock",
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { email: "target@example.com" },
      });
      expect(unblockRes.statusCode).toBe(200);
      expect(unblockRes.json().blockedAt).toBeNull();
    });

    it("404s blocking an unknown email", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/admin/users/block",
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { email: "nobody@example.com" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("403s a non-admin trying to block a user", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/admin/users/block",
        headers: { authorization: `Bearer ${signAuthToken("some-real-user-id")}` },
        payload: { email: "nobody@example.com" },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /admin/expertise", () => {
    it("creates a topic and returns it", async () => {
      const expertiseRepo = new InMemoryExpertiseRepository();
      const matchingClient = new FakeMatchingClient();
      const app = buildApp(undefined, undefined, undefined, undefined, expertiseRepo, matchingClient);

      const res = await app.inject({
        method: "POST",
        url: "/admin/expertise",
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { subjectName: "Quantum Computing", levelName: "Intro" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().typeName).toBe("Quantum Computing");
      expect(matchingClient.calls).toHaveLength(1);
    });

    it("400s a missing subjectName", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/admin/expertise",
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it("403s a non-admin token", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/admin/expertise",
        headers: { authorization: `Bearer ${signAuthToken("some-real-user-id")}` },
        payload: { subjectName: "x" },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /admin/expertise/import", () => {
    it("bulk-creates multiple topics, reporting per-node failures separately", async () => {
      const expertiseRepo = new InMemoryExpertiseRepository();
      const matchingClient = new FakeMatchingClient();
      const app = buildApp(undefined, undefined, undefined, undefined, expertiseRepo, matchingClient);

      const res = await app.inject({
        method: "POST",
        url: "/admin/expertise/import",
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          nodes: [
            { subjectName: "Rocket Science", levelName: "Beginner" },
            { subjectName: "" },
            { subjectName: "Astrophysics" },
          ],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.created).toHaveLength(2);
      expect(body.failed).toHaveLength(1);
      expect(matchingClient.calls).toHaveLength(2);
    });

    it("400s a non-array nodes body", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/admin/expertise/import",
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { nodes: "not-an-array" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("DELETE /admin/expertise/:levelId", () => {
    it("removes an existing topic level", async () => {
      const expertiseRepo = new InMemoryExpertiseRepository();
      const app = buildApp(undefined, undefined, undefined, undefined, expertiseRepo);
      const created = await expertiseRepo.findOrCreateCustom("Marine Biology", "Intro");

      const res = await app.inject({
        method: "DELETE",
        url: `/admin/expertise/${created.expertiseLevelId}`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });
      expect(res.statusCode).toBe(200);

      const options = await expertiseRepo.listOptions();
      const stillPresent = options.some((t) => t.levels.some((l) => l.id === created.expertiseLevelId));
      expect(stillPresent).toBe(false);
    });

    it("404s an unknown levelId", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/admin/expertise/does-not-exist",
        headers: { authorization: `Bearer ${adminToken()}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  function superadminToken() {
    return signAuthToken("super-1", "superadmin", "boss");
  }

  describe("admin-users management (Version 9 RBAC)", () => {
    it("403s a plain-admin token trying to create an admin account", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/admin/admin-users",
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { username: "newadmin", password: "supersecret1", role: "admin" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("lets a superadmin create a new admin account", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/admin/admin-users",
        headers: { authorization: `Bearer ${superadminToken()}` },
        payload: { username: "newadmin", password: "supersecret1", role: "admin" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ username: "newadmin", role: "admin" });
      expect(res.json().passwordHash).toBeUndefined();
    });

    it("rejects an email-shaped admin username", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/admin/admin-users",
        headers: { authorization: `Bearer ${superadminToken()}` },
        payload: { username: "admin@example.com", password: "supersecret1", role: "admin" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a short password", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/admin/admin-users",
        headers: { authorization: `Bearer ${superadminToken()}` },
        payload: { username: "newadmin", password: "short", role: "admin" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a duplicate username", async () => {
      const app = buildApp();
      await app.inject({
        method: "POST",
        url: "/admin/admin-users",
        headers: { authorization: `Bearer ${superadminToken()}` },
        payload: { username: "dupe", password: "supersecret1", role: "admin" },
      });
      const res = await app.inject({
        method: "POST",
        url: "/admin/admin-users",
        headers: { authorization: `Bearer ${superadminToken()}` },
        payload: { username: "dupe", password: "supersecret1", role: "admin" },
      });
      expect(res.statusCode).toBe(409);
    });

    it("lists admin accounts without exposing password hashes", async () => {
      const app = buildApp();
      await app.inject({
        method: "POST",
        url: "/admin/admin-users",
        headers: { authorization: `Bearer ${superadminToken()}` },
        payload: { username: "listed", password: "supersecret1", role: "admin" },
      });
      const res = await app.inject({ method: "GET", url: "/admin/admin-users", headers: { authorization: `Bearer ${superadminToken()}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json().some((a: { username: string }) => a.username === "listed")).toBe(true);
      expect(res.json().every((a: Record<string, unknown>) => !("passwordHash" in a))).toBe(true);
    });

    it("lets a superadmin revoke another admin account", async () => {
      const app = buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/admin/admin-users",
        headers: { authorization: `Bearer ${superadminToken()}` },
        payload: { username: "revokeme", password: "supersecret1", role: "admin" },
      });
      const res = await app.inject({
        method: "DELETE",
        url: `/admin/admin-users/${created.json().id}`,
        headers: { authorization: `Bearer ${superadminToken()}` },
      });
      expect(res.statusCode).toBe(204);
    });

    it("refuses to let a superadmin revoke their own account", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/admin/admin-users/super-1",
        headers: { authorization: `Bearer ${superadminToken()}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /admin/audit-log", () => {
    it("401s with no token", async () => {
      const app = buildApp();
      const res = await app.inject({ method: "GET", url: "/admin/audit-log" });
      expect(res.statusCode).toBe(401);
    });

    it("a plain admin (not just superadmin) can read the audit log", async () => {
      const app = buildApp();
      const res = await app.inject({ method: "GET", url: "/admin/audit-log", headers: { authorization: `Bearer ${adminToken()}` } });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });

    it("records an entry when an admin blocks a user", async () => {
      const userRepo = new InMemoryUserRepository();
      await userRepo.findOrCreateByIdentifier("toblock@example.com", true);
      const app = buildApp(undefined, undefined, userRepo);

      await app.inject({
        method: "POST",
        url: "/admin/users/block",
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { email: "toblock@example.com" },
      });

      const res = await app.inject({ method: "GET", url: "/admin/audit-log", headers: { authorization: `Bearer ${adminToken()}` } });
      const entries = res.json();
      expect(entries.some((e: { action: string }) => e.action === "block_user")).toBe(true);
    });
  });

  describe("POST /internal/admin-audit-log", () => {
    const originalInternalToken = process.env.INTERNAL_SERVICE_TOKEN;
    beforeAll(() => {
      process.env.INTERNAL_SERVICE_TOKEN = "test-internal-secret";
    });
    afterAll(() => {
      process.env.INTERNAL_SERVICE_TOKEN = originalInternalToken;
    });

    it("rejects without a valid internal token", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/admin-audit-log",
        payload: { adminUserId: "a", adminUsername: "a", action: "refund", targetType: "payment", targetId: "p1" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("lets another service record an audit entry, then it's visible via GET /admin/audit-log", async () => {
      const app = buildApp();
      const create = await app.inject({
        method: "POST",
        url: "/internal/admin-audit-log",
        headers: { "x-internal-service-token": "test-internal-secret" },
        payload: {
          adminUserId: "admin",
          adminUsername: "admin",
          action: "refund_booking",
          targetType: "booking",
          targetId: "booking-123",
          metadata: { paymentId: "pay-1" },
        },
      });
      expect(create.statusCode).toBe(201);

      const list = await app.inject({ method: "GET", url: "/admin/audit-log", headers: { authorization: `Bearer ${adminToken()}` } });
      expect(list.json().some((e: { action: string }) => e.action === "refund_booking")).toBe(true);
    });
  });

  describe("GET/POST /admin/gateway-routes", () => {
    it("403s a plain admin (superadmin only)", async () => {
      const app = buildApp();
      const res = await app.inject({ method: "GET", url: "/admin/gateway-routes", headers: { authorization: `Bearer ${adminToken()}` } });
      expect(res.statusCode).toBe(403);
    });

    it("lets a superadmin read the current routes", async () => {
      const gatewayClient = new FakeGatewayClient();
      const app = buildApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, gatewayClient);
      const res = await app.inject({ method: "GET", url: "/admin/gateway-routes", headers: { authorization: `Bearer ${superadminToken()}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(gatewayClient.routes);
    });

    it("lets a superadmin replace the routing table and records an audit entry", async () => {
      const gatewayClient = new FakeGatewayClient();
      const app = buildApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, gatewayClient);
      const newRoutes = [{ prefix: "/doubts", upstream: "http://doubt-service" }];
      const res = await app.inject({
        method: "POST",
        url: "/admin/gateway-routes",
        headers: { authorization: `Bearer ${superadminToken()}` },
        payload: newRoutes,
      });
      expect(res.statusCode).toBe(200);
      expect(gatewayClient.updateCalls).toHaveLength(1);

      const auditRes = await app.inject({ method: "GET", url: "/admin/audit-log", headers: { authorization: `Bearer ${adminToken()}` } });
      expect(auditRes.json().some((e: { action: string }) => e.action === "update_gateway_routes")).toBe(true);
    });

    it("400s an empty route list", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/admin/gateway-routes",
        headers: { authorization: `Bearer ${superadminToken()}` },
        payload: [],
      });
      expect(res.statusCode).toBe(400);
    });
  });
});

describe("log level management", () => {
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
    const app = buildApp(new InMemoryOtpStore(), new RecordingEmailSender(), userRepo, undefined, new InMemoryExpertiseRepository(), new FakeMatchingClient(), statsRepo);
    return { app };
  }

  it("rejects without a valid internal token", async () => {
    const { app } = build();
    const res = await app.inject({ method: "GET", url: "/internal/log-level" });
    expect(res.statusCode).toBe(401);
  });

  it("reads and changes the runtime log level, then resets it", async () => {
    const { app } = build();
    const get = await app.inject({ method: "GET", url: "/internal/log-level", headers: { "x-internal-service-token": "test-internal-secret" } });
    expect(get.json().level).toBe("info");

    const set = await app.inject({
      method: "POST",
      url: "/internal/log-level",
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { level: "debug" },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().level).toBe("debug");

    await app.inject({
      method: "POST",
      url: "/internal/log-level",
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { level: "info" },
    });
  });

  it("rejects an unrecognized level", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/internal/log-level",
      headers: { "x-internal-service-token": "test-internal-secret" },
      payload: { level: "verbose" },
    });
    expect(res.statusCode).toBe(400);
  });
});
