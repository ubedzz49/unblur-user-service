import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { OtpStore, InMemoryOtpStore } from "./otp/store.js";
import { OtpService } from "./otp/service.js";
import { signAuthToken, verifyAuthToken } from "./jwt.js";
import { EmailSender, RecordingEmailSender } from "./email/sender.js";
import { UserRepository, InMemoryUserRepository } from "./users/repository.js";

interface SendOtpBody {
  identifier: string;
}

interface VerifyOtpBody {
  identifier: string;
  otp: string;
}

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) {
    reply.code(401).send({ error: "missing bearer token" });
    return undefined;
  }

  try {
    return verifyAuthToken(token).sub;
  } catch {
    reply.code(401).send({ error: "invalid or expired token" });
    return undefined;
  }
}

export function buildApp(
  otpStore: OtpStore = new InMemoryOtpStore(),
  emailSender: EmailSender = new RecordingEmailSender(),
  userRepository: UserRepository = new InMemoryUserRepository(),
): FastifyInstance {
  const app = Fastify();
  const otpService = new OtpService(otpStore);

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post<{ Body: SendOtpBody }>("/auth/otp/send", async (request, reply) => {
    const { identifier } = request.body ?? {};
    if (!identifier) {
      return reply.code(400).send({ error: "identifier is required" });
    }

    const { otp } = await otpService.send(identifier);
    const isEmail = EMAIL_PATTERN.test(identifier);

    if (isEmail) {
      await emailSender.send(
        identifier,
        "Your Unblur verification code",
        `Your verification code is ${otp}. It expires in 10 minutes.`,
      );
      return reply.send({ sent: true });
    }

    // phone identifiers have no SMS provider wired up yet (Twilio/MSG91 -- see 03_tech_stack.txt) --
    // return the code directly outside production so the flow stays testable until that lands
    if (process.env.NODE_ENV === "production") {
      return reply.send({ sent: true });
    }
    return reply.send({ sent: true, otp });
  });

  app.post<{ Body: VerifyOtpBody }>("/auth/otp/verify", async (request, reply) => {
    const { identifier, otp } = request.body ?? {};
    if (!identifier || !otp) {
      return reply.code(400).send({ error: "identifier and otp are required" });
    }

    const isValid = await otpService.verify(identifier, otp);
    if (!isValid) {
      return reply.code(401).send({ error: "invalid or expired otp" });
    }

    const isEmail = EMAIL_PATTERN.test(identifier);
    const user = await userRepository.findOrCreateByIdentifier(identifier, isEmail);

    const token = signAuthToken(user.id);
    return reply.send({ token });
  });

  app.get("/users/me", async (request, reply) => {
    const userId = await requireAuth(request, reply);
    if (!userId) return;

    const user = await userRepository.findById(userId);
    if (!user) {
      return reply.code(404).send({ error: "user not found" });
    }
    return reply.send(user);
  });

  return app;
}
