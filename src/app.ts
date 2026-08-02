import bcrypt from "bcrypt";
import Fastify, { FastifyBaseLogger, FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { OtpStore, InMemoryOtpStore } from "./otp/store.js";
import { OtpService } from "./otp/service.js";
import { signAuthToken, verifyAuthToken } from "./jwt.js";
import { EmailSender, RecordingEmailSender } from "./email/sender.js";
import { UserRepository, InMemoryUserRepository, ProfileUpdate } from "./users/repository.js";
import {
  ALLOWED_CONTENT_TYPES,
  FakePhotoUploadUrlProvider,
  PhotoUploadUrlProvider,
} from "./photos/upload-url.js";
import {
  DuplicateExpertiseError,
  ExpertiseOptionNotFoundError,
  ExpertiseRepository,
  InMemoryExpertiseRepository,
} from "./expertise/repository.js";
import { HttpMatchingClient, MatchingClient } from "./matching/client.js";
import { InMemoryStatsRepository, StatsRepository } from "./stats/repository.js";
import { requireInternalServiceToken } from "./internal-auth.js";
import { logger } from "./logger.js";
import { AdminRole, AdminUsersRepository, InMemoryAdminUsersRepository } from "./admin/repository.js";
import { AuditLogRepository, InMemoryAuditLogRepository } from "./admin/audit-log-repository.js";

interface BulkUsersBody {
  userIds?: string[];
}

const MAX_BULK_USER_IDS = 20;

interface SendOtpBody {
  identifier: string;
}

interface VerifyOtpBody {
  identifier: string;
  otp: string;
}

interface PasswordLoginBody {
  identifier: string;
  password: string;
}

interface SetPasswordBody {
  currentPassword?: string;
  newPassword: string;
}

// bcrypt cost factor -- 12 is a reasonable default for interactive login in 2026 hardware terms,
// comfortably above the "don't go below 10" floor without making login noticeably slow
const BCRYPT_COST_FACTOR = 12;
// widely-cited practical minimum for password length; short enough not to be user-hostile,
// long enough to rule out the worst trivially-guessable passwords
const MIN_PASSWORD_LENGTH = 8;
// a bcrypt hash of a password nobody has: used to run bcrypt.compare's full cost even when the
// looked-up user has no password_hash, so the "user not found" and "user has no password" cases
// take about as long as the "wrong password" case and don't leak which case occurred via timing
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEeOx0d2r8XX9XcQ2Jz1jP4YHzYyq7z7HcC";

interface PhotoUploadUrlBody {
  contentType: string;
}

interface AddExpertiseBody {
  expertiseTypeId: string;
  expertiseLevelId: string;
}

interface CustomExpertiseBody {
  subjectName: string;
  levelName?: string;
}

interface BlockUserBody {
  email?: string;
}

interface AdminExpertiseImportBody {
  nodes?: { subjectName?: string; levelName?: string }[];
}

interface ListUsersQuery {
  limit?: string;
  offset?: string;
}

const DEFAULT_ADMIN_LIST_LIMIT = 50;
const MAX_ADMIN_LIST_LIMIT = 200;

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// one calendar day -- anything above this in a single increment is clearly bogus input,
// not a real completed booking
const MAX_MINUTES_RESOLVED_PER_CALL = 1440;

interface IncrementMinutesResolvedBody {
  minutes: number;
}

interface RecordRatingBody {
  rating: number;
}

// 02_architecture.txt 2.7/2.8: seminar hosting needs 300+ mins resolved and 3.5+ avg rating;
// GD organizing needs 100+ mins; GD attending needs 50+ mins. The doc doesn't spell out which
// specific stat funds the two GD thresholds -- organizing is gated on minutesResolved (same
// stat as seminar hosting, since organizing a GD is closer to a resolver-track activity) and
// attending is gated on minutesListener (attending is a listener-side activity), which is the
// natural reading of "organize" vs "attend" given the two stats this service tracks.
const SEMINAR_HOST_MIN_MINUTES_RESOLVED = 300;
const SEMINAR_HOST_MIN_AVG_RATING = 3.5;
const GD_ORGANIZE_MIN_MINUTES_RESOLVED = 100;
const GD_ATTEND_MIN_MINUTES_LISTENER = 50;

function computeEligibility(stats: { minutesResolved: number; avgRating: number; minutesListener: number }) {
  return {
    canHostSeminar:
      stats.minutesResolved >= SEMINAR_HOST_MIN_MINUTES_RESOLVED && stats.avgRating >= SEMINAR_HOST_MIN_AVG_RATING,
    canOrganizeGD: stats.minutesResolved >= GD_ORGANIZE_MIN_MINUTES_RESOLVED,
    canAttendGD: stats.minutesListener >= GD_ATTEND_MIN_MINUTES_LISTENER,
  };
}

async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) {
    request.log.warn("auth rejected: missing bearer token");
    reply.code(401).send({ error: "missing bearer token" });
    return undefined;
  }

  try {
    return verifyAuthToken(token).sub;
  } catch (err) {
    request.log.warn({ err }, "auth rejected: invalid or expired token");
    reply.code(401).send({ error: "invalid or expired token" });
    return undefined;
  }
}

// this service verifies the JWT itself (it's the one that signs them), so the admin check reads
// the role claim directly off the token rather than trusting a gateway-forwarded header the way
// every other service's admin routes do. superadmin is a strictly higher tier than admin
// (per Version 9 RBAC) -- anywhere requireAdminAuth allows "admin" through, "superadmin" is
// allowed too.
async function requireAdminAuth(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) {
    reply.code(401).send({ error: "missing bearer token" });
    return false;
  }

  try {
    const payload = verifyAuthToken(token);
    if (payload.role !== "admin" && payload.role !== "superadmin") {
      reply.code(403).send({ error: "admin access required" });
      return false;
    }
    return true;
  } catch (err) {
    request.log.warn({ err }, "admin auth rejected: invalid or expired token");
    reply.code(401).send({ error: "invalid or expired token" });
    return false;
  }
}

// only superadmin can manage other admin accounts or read the audit log -- a strictly narrower
// gate than requireAdminAuth, not a separate concept
async function requireSuperadminAuth(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) {
    reply.code(401).send({ error: "missing bearer token" });
    return false;
  }

  try {
    const payload = verifyAuthToken(token);
    if (payload.role !== "superadmin") {
      reply.code(403).send({ error: "superadmin access required" });
      return false;
    }
    return true;
  } catch (err) {
    request.log.warn({ err }, "superadmin auth rejected: invalid or expired token");
    reply.code(401).send({ error: "invalid or expired token" });
    return false;
  }
}

// extracts {adminUserId, username, role} from an already-verified admin bearer token, for
// audit-log entries -- callers must have already passed requireAdminAuth/requireSuperadminAuth
function adminContextFrom(request: FastifyRequest): { adminUserId: string; username: string; role: string } {
  const header = request.headers.authorization as string;
  const token = header.slice("Bearer ".length);
  const payload = verifyAuthToken(token);
  return { adminUserId: payload.sub, username: payload.username ?? "unknown", role: payload.role ?? "admin" };
}

export function buildApp(
  otpStore: OtpStore = new InMemoryOtpStore(),
  emailSender: EmailSender = new RecordingEmailSender(),
  userRepository: UserRepository = new InMemoryUserRepository(),
  photoUploadUrlProvider: PhotoUploadUrlProvider = new FakePhotoUploadUrlProvider(),
  expertiseRepository: ExpertiseRepository = new InMemoryExpertiseRepository(),
  matchingClient: MatchingClient = new HttpMatchingClient(),
  statsRepository: StatsRepository = new InMemoryStatsRepository(),
  adminUsersRepository: AdminUsersRepository = new InMemoryAdminUsersRepository(),
  auditLogRepository: AuditLogRepository = new InMemoryAuditLogRepository(),
): FastifyInstance {
  // request/response logging is off during tests to keep test output readable -- level
  // otherwise configurable via LOG_LEVEL (info by default) and mutable at runtime, see
  // POST /internal/log-level below
  const app = Fastify(
    process.env.NODE_ENV === "test"
      ? { logger: false }
      : { loggerInstance: logger as unknown as FastifyBaseLogger },
  );

  // Fastify's default JSON parser rejects an empty body when Content-Type: application/json is
  // set, even for methods like DELETE that legitimately have no body -- our own frontend sends
  // that header unconditionally on every request, so this bites any no-body call otherwise.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    if (body === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  const otpService = new OtpService(otpStore);

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post<{ Body: SendOtpBody }>("/auth/otp/send", async (request, reply) => {
    const { identifier } = request.body ?? {};
    if (!identifier) {
      request.log.warn("otp send rejected: missing identifier");
      return reply.code(400).send({ error: "identifier is required" });
    }

    const isEmail = EMAIL_PATTERN.test(identifier);
    const { otp } = await otpService.send(identifier);

    if (isEmail) {
      await emailSender.send(
        identifier,
        "Your Unblur verification code",
        `Your verification code is ${otp}. It expires in 10 minutes.`,
      );
      request.log.info({ identifierType: "email" }, "otp sent via email");
      return reply.send({ sent: true });
    }

    // phone identifiers have no SMS provider wired up yet (Twilio/MSG91 -- see 03_tech_stack.txt) --
    // return the code directly outside production so the flow stays testable until that lands
    request.log.info({ identifierType: "phone" }, "otp generated, no sms provider -- returned in response");
    if (process.env.NODE_ENV === "production") {
      return reply.send({ sent: true });
    }
    return reply.send({ sent: true, otp });
  });

  app.post<{ Body: VerifyOtpBody }>("/auth/otp/verify", async (request, reply) => {
    const { identifier, otp } = request.body ?? {};
    if (!identifier || !otp) {
      request.log.warn("otp verify rejected: missing identifier or otp");
      return reply.code(400).send({ error: "identifier and otp are required" });
    }

    const isValid = await otpService.verify(identifier, otp);
    if (!isValid) {
      request.log.warn("otp verify failed: invalid or expired code");
      return reply.code(401).send({ error: "invalid or expired otp" });
    }

    const isEmail = EMAIL_PATTERN.test(identifier);
    const { user, isNew } = await userRepository.findOrCreateByIdentifier(identifier, isEmail);

    if (user.blockedAt) {
      request.log.warn({ userId: user.id }, "otp verify rejected: account is blocked");
      return reply.code(403).send({ error: "this account has been blocked" });
    }

    // in-memory repo path (real Postgres path already does this in the same db transaction
    // as the user insert, see PostgresUserRepository.findOrCreateByIdentifier) -- idempotent
    // either way, so calling it unconditionally is harmless
    if (isNew) await statsRepository.initializeForUser(user.id);

    const token = signAuthToken(user.id);
    request.log.info({ userId: user.id, isNew }, "otp verified, user logged in");
    return reply.send({ token, isNewUser: isNew });
  });

  // NOTE: this endpoint is a brute-force target (attacker-controlled identifier + password,
  // no lockout) -- it has no rate-limiting because this repo has no rate-limiting
  // infrastructure to hook into yet. Flagging this rather than silently shipping it: this
  // needs rate-limiting (e.g. per-identifier and per-IP) before password login becomes a
  // primary auth path at any real scale.
  app.post<{ Body: PasswordLoginBody }>("/auth/password/login", async (request, reply) => {
    const { identifier, password } = request.body ?? {};
    if (!identifier || !password) {
      request.log.warn("password login rejected: missing identifier or password");
      return reply.code(400).send({ error: "identifier and password are required" });
    }

    // real admin accounts (Version 9 RBAC, admin_users table) -- checked before any real-user
    // lookup. An admin username is never email/phone-shaped (enforced at creation time), so it
    // can never collide with a real identifier. Falls through to the dummy-hash compare below
    // (not a separate early return before that) so a wrong admin password takes the same code
    // path/timing as any other wrong-password attempt.
    const adminAccount = await adminUsersRepository.findByUsername(identifier);
    if (adminAccount) {
      const adminMatches = await bcrypt.compare(password, adminAccount.passwordHash);
      if (!adminMatches) {
        request.log.warn("admin password login rejected: invalid credentials");
        return reply.code(401).send({ error: "invalid credentials" });
      }
      const token = signAuthToken(adminAccount.id, adminAccount.role, adminAccount.username);
      request.log.info({ adminUserId: adminAccount.id, role: adminAccount.role }, "admin password login succeeded");
      return reply.send({ token, mustResetPassword: false, isAdmin: true });
    }

    const record = await userRepository.findByIdentifierWithPassword(identifier);
    // always run bcrypt.compare against *something*, even when there's no user or no password
    // set, so response timing doesn't reveal which of the three failure cases occurred
    const hashToCompare = record?.passwordHash ?? DUMMY_HASH;
    const matches = await bcrypt.compare(password, hashToCompare);

    if (!record || !record.passwordHash || !matches) {
      request.log.warn("password login rejected: invalid credentials");
      return reply.code(401).send({ error: "invalid credentials" });
    }

    if (record.blockedAt) {
      request.log.warn({ userId: record.id }, "password login rejected: account is blocked");
      return reply.code(403).send({ error: "this account has been blocked" });
    }

    const token = signAuthToken(record.id);
    request.log.info({ userId: record.id }, "password login succeeded");
    return reply.send({ token, mustResetPassword: record.mustResetPassword, isAdmin: false });
  });

  app.get("/users/me", async (request, reply) => {
    const userId = await requireAuth(request, reply);
    if (!userId) return;

    const user = await userRepository.findById(userId);
    if (!user) {
      request.log.warn({ userId }, "profile fetch failed: user not found");
      return reply.code(404).send({ error: "user not found" });
    }
    return reply.send(user);
  });

  app.patch<{ Body: ProfileUpdate }>("/users/me", async (request, reply) => {
    const userId = await requireAuth(request, reply);
    if (!userId) return;

    const { name, photoUrl, bio, aiNotesAndTranscriptsEnabled } = request.body ?? {};
    const updated = await userRepository.updateProfile(userId, {
      name,
      photoUrl,
      bio,
      aiNotesAndTranscriptsEnabled,
    });
    if (!updated) {
      request.log.warn({ userId }, "profile update failed: user not found");
      return reply.code(404).send({ error: "user not found" });
    }
    request.log.info(
      { userId, fieldsUpdated: Object.keys(request.body ?? {}) },
      "profile updated",
    );
    return reply.send(updated);
  });

  app.post<{ Body: SetPasswordBody }>("/users/me/password", async (request, reply) => {
    const userId = await requireAuth(request, reply);
    if (!userId) return;

    const { currentPassword, newPassword } = request.body ?? {};
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
      request.log.warn({ userId }, "set password rejected: newPassword too short");
      return reply.code(400).send({ error: `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const info = await userRepository.findPasswordInfoById(userId);
    if (!info) {
      request.log.warn({ userId }, "set password failed: user not found");
      return reply.code(404).send({ error: "user not found" });
    }

    // a password is already set (including the shared default backfilled for pre-existing
    // users) -- the caller must prove they know it before replacing it
    if (info.passwordHash) {
      const currentMatches = currentPassword
        ? await bcrypt.compare(currentPassword, info.passwordHash)
        : false;
      if (!currentMatches) {
        request.log.warn({ userId }, "set password rejected: current password incorrect");
        return reply.code(401).send({ error: "current password is incorrect" });
      }
    }
    // else: OTP-only user setting a password for the first time -- currentPassword not required

    const newHash = await bcrypt.hash(newPassword, BCRYPT_COST_FACTOR);
    await userRepository.setPassword(userId, newHash, false);
    request.log.info({ userId }, "password set");
    return reply.send({ ok: true });
  });

  app.post<{ Body: PhotoUploadUrlBody }>("/users/me/photo-upload-url", async (request, reply) => {
    const userId = await requireAuth(request, reply);
    if (!userId) return;

    const { contentType } = request.body ?? {};
    if (!contentType || !ALLOWED_CONTENT_TYPES.includes(contentType)) {
      request.log.warn({ userId, contentType }, "photo upload url rejected: unsupported content type");
      return reply.code(400).send({
        error: `contentType must be one of: ${ALLOWED_CONTENT_TYPES.join(", ")}`,
      });
    }

    const { uploadUrl, publicUrl } = await photoUploadUrlProvider.createUploadUrl(userId, contentType);
    request.log.info({ userId }, "photo upload url issued");
    return reply.send({ uploadUrl, publicUrl });
  });

  app.get("/expertise-options", async () => {
    return expertiseRepository.listOptions();
  });

  app.post<{ Body: CustomExpertiseBody }>("/expertise-options/custom", async (request, reply) => {
    const userId = await requireAuth(request, reply);
    if (!userId) return;

    const { subjectName, levelName } = request.body ?? {};
    if (!subjectName || typeof subjectName !== "string" || !subjectName.trim()) {
      request.log.warn({ userId }, "custom expertise rejected: missing subjectName");
      return reply.code(400).send({ error: "subjectName is required" });
    }

    const result = await expertiseRepository.findOrCreateCustom(subjectName, levelName);

    const label = levelName ? `${subjectName.trim()} (${levelName.trim()})` : subjectName.trim();
    // Embed immediately so the node is searchable via semantic matching right away rather than
    // waiting for the next backfill. Graceful degradation: if this fails, the taxonomy node
    // still gets created and returned successfully -- HttpMatchingClient already swallows its
    // own errors, but we defensively catch here too so a misbehaving client can never fail
    // this request.
    try {
      await matchingClient.embedNode(result.expertiseTypeId, result.expertiseLevelId, label);
    } catch (err) {
      request.log.warn({ userId, err }, "embed-node call failed, continuing without it");
    }

    request.log.info(
      { userId, expertiseTypeId: result.expertiseTypeId, expertiseLevelId: result.expertiseLevelId },
      "custom expertise created or reused",
    );
    return reply.code(201).send(result);
  });

  app.get("/users/me/expertise", async (request, reply) => {
    const userId = await requireAuth(request, reply);
    if (!userId) return;

    return expertiseRepository.listForUser(userId);
  });

  app.post<{ Body: AddExpertiseBody }>("/users/me/expertise", async (request, reply) => {
    const userId = await requireAuth(request, reply);
    if (!userId) return;

    const { expertiseTypeId, expertiseLevelId } = request.body ?? {};
    if (!expertiseTypeId || !expertiseLevelId) {
      request.log.warn({ userId }, "add expertise rejected: missing type or level");
      return reply.code(400).send({ error: "expertiseTypeId and expertiseLevelId are required" });
    }

    try {
      const entry = await expertiseRepository.addForUser(userId, expertiseTypeId, expertiseLevelId);
      request.log.info({ userId, expertiseTypeId, expertiseLevelId }, "expertise added");
      return reply.code(201).send(entry);
    } catch (err) {
      if (err instanceof DuplicateExpertiseError) {
        request.log.warn({ userId, expertiseTypeId, expertiseLevelId }, "add expertise rejected: already added");
        return reply.code(409).send({ error: "you've already added this expertise and level" });
      }
      if (err instanceof ExpertiseOptionNotFoundError) {
        request.log.warn({ userId, expertiseTypeId, expertiseLevelId }, "add expertise rejected: unknown option");
        return reply.code(400).send({ error: "unknown expertiseTypeId or expertiseLevelId" });
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>("/users/me/expertise/:id", async (request, reply) => {
    const userId = await requireAuth(request, reply);
    if (!userId) return;

    const removed = await expertiseRepository.removeForUser(userId, request.params.id);
    if (!removed) {
      request.log.warn({ userId, userExpertiseId: request.params.id }, "remove expertise failed: not found");
      return reply.code(404).send({ error: "not found" });
    }
    request.log.info({ userId, userExpertiseId: request.params.id }, "expertise removed");
    return reply.code(204).send();
  });

  app.get("/users/me/stats", async (request, reply) => {
    const userId = await requireAuth(request, reply);
    if (!userId) return;

    const stats = await statsRepository.findByUserId(userId);
    // shouldn't happen given the backfill/on-create guarantee, but don't crash if it does
    if (!stats) {
      request.log.warn({ userId }, "stats fetch failed: no stats row");
      return reply.code(404).send({ error: "stats not found" });
    }
    return reply.send({
      minutesResolved: stats.minutesResolved,
      avgRating: stats.avgRating,
      ratingCount: stats.ratingCount,
      minutesListener: stats.minutesListener,
      gdPoints: stats.gdPoints,
      updatedAt: stats.updatedAt,
      eligibility: computeEligibility(stats),
    });
  });

  app.get<{ Params: { id: string } }>("/users/:id/public", async (request, reply) => {
    const userId = await requireAuth(request, reply);
    if (!userId) return;

    const { id } = request.params;
    if (!UUID_PATTERN.test(id)) {
      request.log.warn({ requestedId: id }, "public profile rejected: malformed id");
      return reply.code(400).send({ error: "id must be a valid uuid" });
    }

    const user = await userRepository.findById(id);
    if (!user) {
      request.log.warn({ requestedId: id }, "public profile fetch failed: user not found");
      return reply.code(404).send({ error: "user not found" });
    }
    const stats = await statsRepository.findByUserId(id);
    if (!stats) {
      request.log.warn({ requestedId: id }, "public profile fetch failed: no stats row");
      return reply.code(404).send({ error: "user not found" });
    }
    const expertise = await expertiseRepository.listForUser(id);

    // no email/phone -- that stays private, but bio and expertise help the other side of a
    // resolution request decide whether to accept/send
    return reply.send({
      id: user.id,
      name: user.name,
      photoUrl: user.photoUrl,
      bio: user.bio,
      expertise: expertise.map((e) => ({
        id: e.id,
        expertiseTypeName: e.expertiseTypeName,
        expertiseLevelName: e.expertiseLevelName,
      })),
      stats: {
        minutesResolved: stats.minutesResolved,
        avgRating: stats.avgRating,
        ratingCount: stats.ratingCount,
        minutesListener: stats.minutesListener,
        gdPoints: stats.gdPoints,
        eligibility: computeEligibility(stats),
      },
    });
  });

  app.post<{ Params: { id: string }; Body: IncrementMinutesResolvedBody }>(
    "/internal/users/:id/stats/increment-minutes-resolved",
    async (request, reply) => {
      // service-to-service only -- deliberately not requireAuth/JWT, since no end user's
      // token should ever be able to touch another user's stats
      if (!requireInternalServiceToken(request, reply)) return;

      const { id } = request.params;
      if (!UUID_PATTERN.test(id)) {
        request.log.warn({ requestedId: id }, "increment-minutes-resolved rejected: malformed id");
        return reply.code(400).send({ error: "id must be a valid uuid" });
      }

      const { minutes } = request.body ?? ({} as IncrementMinutesResolvedBody);
      if (
        typeof minutes !== "number" ||
        !Number.isInteger(minutes) ||
        minutes <= 0 ||
        minutes > MAX_MINUTES_RESOLVED_PER_CALL
      ) {
        request.log.warn({ requestedId: id, minutes }, "increment-minutes-resolved rejected: invalid minutes");
        return reply.code(400).send({
          error: `minutes must be a positive integer no greater than ${MAX_MINUTES_RESOLVED_PER_CALL}`,
        });
      }

      const newTotal = await statsRepository.incrementMinutesResolved(id, minutes);
      if (newTotal === null) {
        request.log.warn({ requestedId: id }, "increment-minutes-resolved failed: user not found");
        return reply.code(404).send({ error: "user not found" });
      }

      request.log.info({ requestedId: id, minutes }, "minutes_resolved incremented via internal call");
      return reply.send({ minutesResolved: newTotal });
    },
  );

  app.post<{ Params: { id: string }; Body: RecordRatingBody }>(
    "/internal/users/:id/stats/record-rating",
    async (request, reply) => {
      // service-to-service only -- same reasoning as increment-minutes-resolved above
      if (!requireInternalServiceToken(request, reply)) return;

      const { id } = request.params;
      if (!UUID_PATTERN.test(id)) {
        request.log.warn({ requestedId: id }, "record-rating rejected: malformed id");
        return reply.code(400).send({ error: "id must be a valid uuid" });
      }

      const { rating } = request.body ?? ({} as RecordRatingBody);
      if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) {
        request.log.warn({ requestedId: id, rating }, "record-rating rejected: invalid rating");
        return reply.code(400).send({ error: "rating must be an integer between 1 and 5" });
      }

      const result = await statsRepository.recordRating(id, rating);
      if (result === null) {
        request.log.warn({ requestedId: id }, "record-rating failed: user not found");
        return reply.code(404).send({ error: "user not found" });
      }

      request.log.info({ requestedId: id, rating }, "rating recorded via internal call");
      return reply.send({ avgRating: result.avgRating, ratingCount: result.ratingCount });
    },
  );

  // service-to-service only -- lets AI Notes Service (and any future caller) resolve a small
  // participant list to profile+toggle in one round trip instead of N calls. Looped findById
  // rather than a new bulk repository method -- session participant lists are 2-3 users
  // (poster+resolver today), not worth a new SQL path for.
  // service-to-service only -- Seminar/GD services need to gate create-seminar/create-gd/join
  // on the caller's eligibility, but they only ever see the gateway's X-User-Id header, never
  // the caller's own JWT that /users/me/stats requires. No existing internal route exposed
  // eligibility for an arbitrary user id, so this is a genuinely new addition rather than reuse.
  app.get<{ Params: { id: string } }>("/internal/users/:id/eligibility", async (request, reply) => {
    if (!requireInternalServiceToken(request, reply)) return;

    const { id } = request.params;
    if (!UUID_PATTERN.test(id)) {
      return reply.code(400).send({ error: "id must be a valid uuid" });
    }

    const stats = await statsRepository.findByUserId(id);
    if (!stats) {
      return reply.code(404).send({ error: "stats not found" });
    }
    return reply.send(computeEligibility(stats));
  });

  app.post<{ Params: { id: string }; Body: { minutes: number } }>(
    "/internal/users/:id/stats/increment-minutes-listener",
    async (request, reply) => {
      if (!requireInternalServiceToken(request, reply)) return;

      const { id } = request.params;
      if (!UUID_PATTERN.test(id)) {
        return reply.code(400).send({ error: "id must be a valid uuid" });
      }

      const { minutes } = request.body ?? ({} as { minutes: number });
      if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes <= 0 || minutes > MAX_MINUTES_RESOLVED_PER_CALL) {
        return reply.code(400).send({
          error: `minutes must be a positive integer no greater than ${MAX_MINUTES_RESOLVED_PER_CALL}`,
        });
      }

      const newTotal = await statsRepository.incrementMinutesListener(id, minutes);
      if (newTotal === null) {
        return reply.code(404).send({ error: "user not found" });
      }
      request.log.info({ requestedId: id, minutes }, "minutes_listener incremented via internal call");
      return reply.send({ minutesListener: newTotal });
    },
  );

  app.post<{ Params: { id: string }; Body: { points: number } }>(
    "/internal/users/:id/stats/increment-gd-points",
    async (request, reply) => {
      if (!requireInternalServiceToken(request, reply)) return;

      const { id } = request.params;
      if (!UUID_PATTERN.test(id)) {
        return reply.code(400).send({ error: "id must be a valid uuid" });
      }

      const { points } = request.body ?? ({} as { points: number });
      if (typeof points !== "number" || !Number.isFinite(points) || points < 0) {
        return reply.code(400).send({ error: "points must be a non-negative number" });
      }

      const newTotal = await statsRepository.incrementGdPoints(id, points);
      if (newTotal === null) {
        return reply.code(404).send({ error: "user not found" });
      }
      request.log.info({ requestedId: id, points }, "gd_points incremented via internal call");
      return reply.send({ gdPoints: newTotal });
    },
  );

  const VALID_LOG_LEVELS = ["info", "debug", "error"];

  // runtime-mutable logging verbosity, no redeploy needed -- see src/logger.ts for the custom
  // info<debug<error severity ordering this project uses (not pino's default trace<debug<info<
  // warn<error<fatal). Gated the same as every other internal route.
  app.get("/internal/log-level", async (request, reply) => {
    if (!requireInternalServiceToken(request, reply)) return;
    return reply.send({ level: logger.level });
  });

  app.post<{ Body: { level?: string } }>("/internal/log-level", async (request, reply) => {
    if (!requireInternalServiceToken(request, reply)) return;

    const { level } = request.body ?? {};
    if (typeof level !== "string" || !VALID_LOG_LEVELS.includes(level)) {
      return reply.code(400).send({ error: `level must be one of ${VALID_LOG_LEVELS.join(", ")}` });
    }
    logger.level = level;
    request.log.info({ level }, "log level changed at runtime");
    return reply.send({ level: logger.level });
  });

  app.post<{ Body: BulkUsersBody }>("/internal/users/bulk", async (request, reply) => {
    if (!requireInternalServiceToken(request, reply)) return;

    const { userIds } = request.body ?? ({} as BulkUsersBody);
    if (!Array.isArray(userIds) || userIds.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
      return reply.code(400).send({ error: "userIds must be an array of valid uuids" });
    }
    if (userIds.length > MAX_BULK_USER_IDS) {
      return reply.code(400).send({ error: `userIds cannot exceed ${MAX_BULK_USER_IDS}` });
    }

    const found = await Promise.all(userIds.map((id) => userRepository.findById(id)));
    const users = found
      .filter((u): u is NonNullable<typeof u> => u !== null)
      .map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        aiNotesAndTranscriptsEnabled: u.aiNotesAndTranscriptsEnabled,
      }));
    return reply.send({ users });
  });

  app.get<{ Querystring: ListUsersQuery }>("/admin/users", async (request, reply) => {
    if (!(await requireAdminAuth(request, reply))) return;

    const limit = Math.min(Number(request.query.limit ?? DEFAULT_ADMIN_LIST_LIMIT) || DEFAULT_ADMIN_LIST_LIMIT, MAX_ADMIN_LIST_LIMIT);
    const offset = Math.max(Number(request.query.offset ?? 0) || 0, 0);
    const users = await userRepository.listUsers(limit, offset);
    return reply.send(users);
  });

  app.post<{ Body: BlockUserBody }>("/admin/users/block", async (request, reply) => {
    if (!(await requireAdminAuth(request, reply))) return;

    const { email } = request.body ?? {};
    if (!email || typeof email !== "string") {
      return reply.code(400).send({ error: "email is required" });
    }

    const user = await userRepository.blockByEmail(email);
    if (!user) {
      return reply.code(404).send({ error: "no user found with that email" });
    }
    const admin = adminContextFrom(request);
    await auditLogRepository.create({
      adminUserId: admin.adminUserId,
      adminUsername: admin.username,
      action: "block_user",
      targetType: "user",
      targetId: user.id,
      metadata: { email },
    });
    request.log.info({ userId: user.id }, "user blocked by admin");
    return reply.send(user);
  });

  app.post<{ Body: BlockUserBody }>("/admin/users/unblock", async (request, reply) => {
    if (!(await requireAdminAuth(request, reply))) return;

    const { email } = request.body ?? {};
    if (!email || typeof email !== "string") {
      return reply.code(400).send({ error: "email is required" });
    }

    const user = await userRepository.unblockByEmail(email);
    if (!user) {
      return reply.code(404).send({ error: "no user found with that email" });
    }
    const admin = adminContextFrom(request);
    await auditLogRepository.create({
      adminUserId: admin.adminUserId,
      adminUsername: admin.username,
      action: "unblock_user",
      targetType: "user",
      targetId: user.id,
      metadata: { email },
    });
    request.log.info({ userId: user.id }, "user unblocked by admin");
    return reply.send(user);
  });

  // Version 9 RBAC: real, multiple admin accounts -- superadmin-only, replacing the single
  // fixed username/password pair
  app.get("/admin/admin-users", async (request, reply) => {
    if (!(await requireSuperadminAuth(request, reply))) return;
    const admins = await adminUsersRepository.list();
    return reply.send(admins.map((a) => ({ id: a.id, username: a.username, role: a.role, createdAt: a.createdAt })));
  });

  app.post<{ Body: { username?: string; password?: string; role?: AdminRole } }>("/admin/admin-users", async (request, reply) => {
    if (!(await requireSuperadminAuth(request, reply))) return;

    const { username, password, role } = request.body ?? {};
    if (typeof username !== "string" || username.trim().length === 0) {
      return reply.code(400).send({ error: "username is required" });
    }
    if (typeof password !== "string" || password.length < 8) {
      return reply.code(400).send({ error: "password must be at least 8 characters" });
    }
    if (role !== "admin" && role !== "superadmin") {
      return reply.code(400).send({ error: "role must be admin or superadmin" });
    }
    if (EMAIL_PATTERN.test(username.trim())) {
      // admin usernames must never be email-shaped -- that's exactly what keeps a real user's
      // identifier from ever colliding with an admin account at login time
      return reply.code(400).send({ error: "username must not look like an email address" });
    }

    const existing = await adminUsersRepository.findByUsername(username.trim());
    if (existing) {
      return reply.code(409).send({ error: "an admin with that username already exists" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST_FACTOR);
    const created = await adminUsersRepository.create({ username: username.trim(), passwordHash, role });

    const admin = adminContextFrom(request);
    await auditLogRepository.create({
      adminUserId: admin.adminUserId,
      adminUsername: admin.username,
      action: "create_admin_user",
      targetType: "admin_user",
      targetId: created.id,
      metadata: { username: created.username, role: created.role },
    });
    request.log.info({ createdAdminId: created.id, role: created.role }, "admin account created");
    return reply.code(201).send({ id: created.id, username: created.username, role: created.role, createdAt: created.createdAt });
  });

  app.delete<{ Params: { id: string } }>("/admin/admin-users/:id", async (request, reply) => {
    if (!(await requireSuperadminAuth(request, reply))) return;

    const admin = adminContextFrom(request);
    if (request.params.id === admin.adminUserId) {
      return reply.code(400).send({ error: "cannot revoke your own admin account" });
    }

    const target = await adminUsersRepository.findById(request.params.id);
    if (!target) {
      return reply.code(404).send({ error: "admin user not found" });
    }

    await adminUsersRepository.delete(target.id);
    await auditLogRepository.create({
      adminUserId: admin.adminUserId,
      adminUsername: admin.username,
      action: "revoke_admin_user",
      targetType: "admin_user",
      targetId: target.id,
      metadata: { username: target.username, role: target.role },
    });
    request.log.info({ revokedAdminId: target.id }, "admin account revoked");
    return reply.code(204).send();
  });

  // any admin can read the audit log (transparency), only superadmin can manage accounts -- a
  // deliberately asymmetric gate
  app.get<{ Querystring: { limit?: string } }>("/admin/audit-log", async (request, reply) => {
    if (!(await requireAdminAuth(request, reply))) return;
    const limit = Math.min(Number(request.query.limit ?? 100) || 100, 500);
    const entries = await auditLogRepository.list(limit);
    return reply.send(entries);
  });

  // service-to-service only -- every other service's admin-gated action (refund, resolve
  // complaint, cancel seminar/gd, send an ad-hoc notification) calls this so every admin action
  // lands in one queryable place, not scattered structured log lines per service
  app.post<{ Body: { adminUserId?: string; adminUsername?: string; action?: string; targetType?: string; targetId?: string; metadata?: Record<string, unknown> } }>(
    "/internal/admin-audit-log",
    async (request, reply) => {
      if (!requireInternalServiceToken(request, reply)) return;

      const { adminUserId, adminUsername, action, targetType, targetId, metadata } = request.body ?? {};
      if (!adminUserId || !adminUsername || !action || !targetType || !targetId) {
        return reply.code(400).send({ error: "adminUserId, adminUsername, action, targetType, and targetId are required" });
      }

      const entry = await auditLogRepository.create({ adminUserId, adminUsername, action, targetType, targetId, metadata });
      return reply.code(201).send(entry);
    },
  );

  // shared by both admin expertise routes below -- same find-or-create + best-effort embed
  // pattern as the user-facing /expertise-options/custom endpoint above
  async function createExpertiseNode(subjectName: string, levelName: string | undefined, log: FastifyRequest["log"]) {
    const result = await expertiseRepository.findOrCreateCustom(subjectName, levelName);
    const label = levelName ? `${subjectName.trim()} (${levelName.trim()})` : subjectName.trim();
    try {
      await matchingClient.embedNode(result.expertiseTypeId, result.expertiseLevelId, label);
    } catch (err) {
      log.warn({ err }, "admin expertise: embed-node call failed, continuing without it");
    }
    return result;
  }

  app.post<{ Body: CustomExpertiseBody }>("/admin/expertise", async (request, reply) => {
    if (!(await requireAdminAuth(request, reply))) return;

    const { subjectName, levelName } = request.body ?? {};
    if (!subjectName || typeof subjectName !== "string" || !subjectName.trim()) {
      return reply.code(400).send({ error: "subjectName is required" });
    }

    const result = await createExpertiseNode(subjectName, levelName, request.log);
    request.log.info({ expertiseTypeId: result.expertiseTypeId }, "expertise topic added by admin");
    return reply.code(201).send(result);
  });

  app.post<{ Body: AdminExpertiseImportBody }>("/admin/expertise/import", async (request, reply) => {
    if (!(await requireAdminAuth(request, reply))) return;

    const { nodes } = request.body ?? {};
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return reply.code(400).send({ error: "nodes must be a non-empty array" });
    }

    const created: unknown[] = [];
    const failed: { subjectName?: string; error: string }[] = [];
    for (const node of nodes) {
      if (!node.subjectName || typeof node.subjectName !== "string" || !node.subjectName.trim()) {
        failed.push({ subjectName: node.subjectName, error: "subjectName is required" });
        continue;
      }
      try {
        const result = await createExpertiseNode(node.subjectName, node.levelName, request.log);
        created.push(result);
      } catch (err) {
        request.log.warn({ err, subjectName: node.subjectName }, "admin bulk expertise import: one node failed");
        failed.push({ subjectName: node.subjectName, error: "failed to create" });
      }
    }

    request.log.info({ createdCount: created.length, failedCount: failed.length }, "admin bulk expertise import complete");
    return reply.code(201).send({ created, failed });
  });

  app.delete<{ Params: { levelId: string } }>("/admin/expertise/:levelId", async (request, reply) => {
    if (!(await requireAdminAuth(request, reply))) return;

    const removed = await expertiseRepository.removeExpertiseLevel(request.params.levelId);
    if (!removed) {
      return reply.code(404).send({ error: "expertise level not found" });
    }
    request.log.info({ levelId: request.params.levelId }, "expertise topic removed by admin");
    return reply.send({ ok: true });
  });

  return app;
}
