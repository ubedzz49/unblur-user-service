import { buildApp } from "./app.js";
import { RedisOtpStore, buildRedisClient } from "./otp/redis-store.js";
import { SendgridEmailSender } from "./email/sendgrid-sender.js";

const port = Number(process.env.PORT ?? 3000);
const app = buildApp(new RedisOtpStore(buildRedisClient()), new SendgridEmailSender());

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`user-service listening on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
