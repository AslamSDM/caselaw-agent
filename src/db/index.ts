import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type DB = ReturnType<typeof drizzle<typeof schema>>;

const globalForDb = globalThis as unknown as { pg?: ReturnType<typeof postgres>; db?: DB };

function getDb(): DB {
  if (globalForDb.db) return globalForDb.db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  // Reuse one pool across hot reloads in dev.
  globalForDb.pg ??= postgres(url, { max: 10, prepare: false });
  globalForDb.db = drizzle({ client: globalForDb.pg, schema });
  return globalForDb.db;
}

/**
 * Connects on first use, so modules that import `db` (and their pure helpers) can be imported
 * without a database — e.g. in unit tests.
 */
export const db: DB = new Proxy({} as DB, {
  get(_target, prop) {
    const real = getDb();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
export { schema };
