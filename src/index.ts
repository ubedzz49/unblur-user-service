import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const app = buildApp();

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`user-service listening on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
