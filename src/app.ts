import bcrypt from "bcrypt";
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
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

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// one calendar day -- anything above this in a single increment is clearly bogus input,
// not a real completed booking
const MAX_MINUTES_RESOLVED_PER_CALL = 1440;

interface IncrementMinutesResolvedBody {
  minutes: number;
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

export function buildApp(
  otpStore: OtpStore = new InMemoryOtpStore(),
  emailSender: EmailSender = new RecordingEmailSender(),
  userRepository: UserRepository = new InMemoryUserRepository(),
  photoUploadUrlProvider: PhotoUploadUrlProvider = new FakePhotoUploadUrlProvider(),
  expertiseRepository: ExpertiseRepository = new InMemoryExpertiseRepository(),
  matchingClient: MatchingClient = new HttpMatchingClient(),
  statsRepository: StatsRepository = new InMemoryStatsRepository(),
): FastifyInstance {
  // request/response logging is off during tests to keep test output readable --
  // level otherwise configurable via LOG_LEVEL (info by default)
  const app = Fastify({
    logger: process.env.NODE_ENV === "test" ? false : { level: process.env.LOG_LEVEL ?? "info" },
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

    const record = await userRepository.findByIdentifierWithPassword(identifier);
    // always run bcrypt.compare against *something*, even when there's no user or no password
    // set, so response timing doesn't reveal which of the three failure cases occurred
    const hashToCompare = record?.passwordHash ?? DUMMY_HASH;
    const matches = await bcrypt.compare(password, hashToCompare);

    if (!record || !record.passwordHash || !matches) {
      request.log.warn("password login rejected: invalid credentials");
      return reply.code(401).send({ error: "invalid credentials" });
    }

    const token = signAuthToken(record.id);
    request.log.info({ userId: record.id }, "password login succeeded");
    return reply.send({ token, mustResetPassword: record.mustResetPassword });
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
      updatedAt: stats.updatedAt,
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

    // deliberately minimal -- no email/phone/bio, this is a privacy boundary not an oversight
    return reply.send({
      id: user.id,
      name: user.name,
      photoUrl: user.photoUrl,
      stats: {
        minutesResolved: stats.minutesResolved,
        avgRating: stats.avgRating,
        ratingCount: stats.ratingCount,
        minutesListener: stats.minutesListener,
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

  return app;
}
