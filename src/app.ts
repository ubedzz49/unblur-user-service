import Fastify, { FastifyInstance } from "fastify";

export function buildApp(): FastifyInstance {
  const app = Fastify();

  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}
