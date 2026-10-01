/**
 * Shared TNA rate limiter. TNA allows 1,000 requests per rolling 5 minutes per IP; we budget
 * TNA_REQUEST_BUDGET (default 900) across all app instances using 10-second buckets in Postgres.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";

const WINDOW_SECONDS = 300;
const BUDGET = Number(process.env.TNA_REQUEST_BUDGET ?? 900);

export async function acquireTnaSlot(signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const rows = await db.execute<{ used: number }>(sql`
      WITH bump AS (
        INSERT INTO rate_limit (bucket_start, count)
        VALUES (to_timestamp(floor(extract(epoch from now()) / 10) * 10), 1)
        ON CONFLICT (bucket_start) DO UPDATE SET count = rate_limit.count + 1
        RETURNING count
      )
      SELECT coalesce(sum(count), 0)::int + (SELECT count FROM bump) AS used
      FROM rate_limit
      WHERE bucket_start > now() - make_interval(secs => ${WINDOW_SECONDS})
        AND bucket_start < to_timestamp(floor(extract(epoch from now()) / 10) * 10)
    `);
    const used = Number(rows[0]?.used ?? 0);
    if (used <= BUDGET) {
      if (attempt === 0 && Math.random() < 0.01) {
        await db.execute(sql`DELETE FROM rate_limit WHERE bucket_start < now() - interval '10 minutes'`);
      }
      return;
    }
    // over budget: give the slot back and wait for the window to slide
    await db.execute(sql`
      UPDATE rate_limit SET count = greatest(count - 1, 0)
      WHERE bucket_start = to_timestamp(floor(extract(epoch from now()) / 10) * 10)
    `);
    if (attempt >= 30) throw new Error("TNA rate limit budget exhausted; try again shortly");
    await new Promise((r) => setTimeout(r, 2000));
  }
}
