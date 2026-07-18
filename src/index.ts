import { buildApp } from "./app.js";
import { RedisOtpStore, buildRedisClient } from "./otp/redis-store.js";
import { SendgridEmailSender } from "./email/sendgrid-sender.js";
import { buildDbPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { PostgresUserRepository } from "./users/postgres-repository.js";

const port = Number(process.env.PORT ?? 3000);
const dbPool = buildDbPool();

runMigrations(dbPool)
  .then(() => {
    const app = buildApp(
      new RedisOtpStore(buildRedisClient()),
      new SendgridEmailSender(),
      new PostgresUserRepository(dbPool),
    );

    return app.listen({ port, host: "0.0.0.0" }).then(() => app.log.info(`user-service listening on :${port}`));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
