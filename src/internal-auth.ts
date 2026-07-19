import { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "./logger.js";

const INTERNAL_TOKEN_HEADER = "x-internal-service-token";

// fail closed: a route that trusts this header must never run if the secret it's
// checking against was never configured -- an unset secret must not mean "accept everything"
export function requireInternalServiceTokenConfigured(): string {
  const token = process.env.INTERNAL_SERVICE_TOKEN;
  if (!token) {
    logger.fatal("INTERNAL_SERVICE_TOKEN is not set -- refusing to start with internal routes exposed");
    process.exit(1);
  }
  return token;
}

// verifies the shared secret used for service-to-service calls (e.g. Resolution Service
// incrementing a user's stats) -- deliberately separate from requireAuth/JWT, since this
// isn't tied to any end user and a real user JWT must never satisfy it
export function requireInternalServiceToken(request: FastifyRequest, reply: FastifyReply): boolean {
  const expected = process.env.INTERNAL_SERVICE_TOKEN;
  if (!expected) {
    // should be unreachable in practice -- requireInternalServiceTokenConfigured() exits at
    // startup if unset, but never fall open here even if that check were ever bypassed
    request.log.error("internal service token check ran with INTERNAL_SERVICE_TOKEN unset");
    reply.code(401).send({ error: "invalid internal service token" });
    return false;
  }

  const provided = request.headers[INTERNAL_TOKEN_HEADER];
  if (!provided || Array.isArray(provided) || provided !== expected) {
    request.log.warn("internal service call rejected: missing or invalid internal service token");
    reply.code(401).send({ error: "invalid internal service token" });
    return false;
  }

  return true;
}
