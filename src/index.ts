import { buildApp } from "./app.js";
import { RedisOtpStore, buildRedisClient } from "./otp/redis-store.js";
import { SendgridEmailSender } from "./email/sendgrid-sender.js";
import { buildDbPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { PostgresUserRepository } from "./users/postgres-repository.js";
import { logger } from "./logger.js";
import { S3PhotoUploadUrlProvider } from "./photos/s3-upload-url.js";
import { PostgresExpertiseRepository } from "./expertise/postgres-repository.js";
import { PostgresStatsRepository } from "./stats/postgres-repository.js";
import { HttpMatchingClient } from "./matching/client.js";
import { requireInternalServiceTokenConfigured } from "./internal-auth.js";
import { PostgresAdminUsersRepository } from "./admin/postgres-repository.js";
import { PostgresAuditLogRepository } from "./admin/postgres-audit-log-repository.js";
import { HttpGatewayClient } from "./admin/gateway-client.js";
import { HttpLogLevelClient } from "./admin/log-level-client.js";

const port = Number(process.env.PORT ?? 3000);
const dbPool = buildDbPool();

// fail closed at startup, same philosophy as JWT_SECRET -- never boot with the internal
// route silently accepting everything because this secret was never configured
requireInternalServiceTokenConfigured();

// Version 9 RBAC bootstrap: the old single fixed ADMIN_USERNAME/ADMIN_PASSWORD_HASH credential
// pair (Secrets Manager) is upserted as a real admin_users row (role: superadmin) on every boot,
// so existing admin access is never lost by this migration -- from here on, new admins are
// created via POST /admin/admin-users instead of a secret-manager credential.
async function seedFixedAdminIfConfigured(repo: PostgresAdminUsersRepository): Promise<void> {
  const username = process.env.ADMIN_USERNAME;
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;
  if (!username || !passwordHash) return;

  const existing = await repo.findByUsername(username);
  if (existing) return;

  await repo.create({ username, passwordHash, role: "superadmin" });
  logger.info({ username }, "seeded the fixed admin credential as a real superadmin account");
}

runMigrations(dbPool)
  .then(async () => {
    const adminUsersRepository = new PostgresAdminUsersRepository(dbPool);
    await seedFixedAdminIfConfigured(adminUsersRepository);

    const app = buildApp(
      new RedisOtpStore(buildRedisClient()),
      new SendgridEmailSender(),
      new PostgresUserRepository(dbPool),
      new S3PhotoUploadUrlProvider(),
      new PostgresExpertiseRepository(dbPool),
      new HttpMatchingClient(),
      new PostgresStatsRepository(dbPool),
      adminUsersRepository,
      new PostgresAuditLogRepository(dbPool),
      new HttpGatewayClient(),
      new HttpLogLevelClient(),
    );

    return app.listen({ port, host: "0.0.0.0" }).then(() => app.log.info({ port }, "user-service listening"));
  })
  .catch((err) => {
    logger.error({ err }, "user-service failed to start");
    process.exit(1);
  });
