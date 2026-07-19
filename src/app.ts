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
    const user = await userRepository.findOrCreateByIdentifier(identifier, isEmail);

    const token = signAuthToken(user.id);
    request.log.info({ userId: user.id }, "otp verified, user logged in");
    return reply.send({ token });
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

  return app;
}
