import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.ts";
import { dbConfigFromEnv, openDb } from "./db.ts";
import { PgStore } from "./store.ts";

const here = dirname(fileURLToPath(import.meta.url));
// PostgreSQL when DATABASE_URL is set; otherwise embedded PGlite in a folder (development, one process).
const db = await openDb(dbConfigFromEnv(resolve(here, "..", "data", "pglite"))).catch((e: Error) => {
  console.error(`db: ${e.message}`);
  process.exit(1);
});
const store = await PgStore.open(db);
console.log(`db: ${db.label}`);
if (db.kind === "pglite") console.warn("db: embedded PGlite is for development and single-process use; set DATABASE_URL to a PostgreSQL server for a real deployment");

const app = createApp(store, {
  adminToken: process.env.ADMIN_TOKEN || undefined,
  corsOrigins: (process.env.CORS_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  registerPerHour: Number(process.env.REGISTER_PER_HOUR ?? 10),
});

// Without Docker the server can also host the built client (`pnpm --filter @pokebattles/client build`).
// The Docker image is API-only; the client container serves the pages (docker-compose.yml).
const clientDist = process.env.CLIENT_DIST ?? resolve(here, "..", "..", "client", "dist");
if (existsSync(clientDist)) {
  const root = clientDist.replaceAll("\\", "/");
  // Sprites are fetched one by one as they appear; let the browser keep them.
  app.use("/assets/*", async (c, next) => {
    await next();
    if (c.res.ok) c.header("Cache-Control", "public, max-age=86400");
  });
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ path: `${root}/index.html` }));
}

const port = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, (info) => {
  console.log(`pokebattles server on http://localhost:${info.port}`);
});

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    server.close();
    store.close().then(
      () => process.exit(0),
      (e) => {
        console.error(e);
        process.exit(1);
      },
    );
  });
}
