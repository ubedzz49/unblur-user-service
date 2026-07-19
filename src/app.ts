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

interface SendOtpBody {
  identifier: string;
}

interface VerifyOtpBody {
  identifier: string;
  otp: string;
}

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

    const token = signAuthToken(user.id);
    request.log.info({ userId: user.id, isNew }, "otp verified, user logged in");
    return reply.send({ token, isNewUser: isNew });
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

  return app;
}
