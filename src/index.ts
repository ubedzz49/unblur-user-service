import { buildApp } from "./app.js";
import { RedisOtpStore, buildRedisClient } from "./otp/redis-store.js";

const port = Number(process.env.PORT ?? 3000);
const app = buildApp(new RedisOtpStore(buildRedisClient()));

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`user-service listening on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
