import Fastify, { FastifyInstance } from "fastify";
import { OtpStore, InMemoryOtpStore } from "./otp/store.js";
import { OtpService } from "./otp/service.js";
import { signAuthToken } from "./jwt.js";
import { EmailSender, RecordingEmailSender } from "./email/sender.js";

interface SendOtpBody {
  identifier: string;
}

interface VerifyOtpBody {
  identifier: string;
  otp: string;
}

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

export function buildApp(
  otpStore: OtpStore = new InMemoryOtpStore(),
  emailSender: EmailSender = new RecordingEmailSender(),
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

    const token = signAuthToken(identifier);
    return reply.send({ token });
  });

  return app;
}
