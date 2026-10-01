/**
 * Embed whole cases (all top-level paragraphs) with the local Ollama model, so they rank fully
 * by meaning and appear in the cache-wide semantic candidate search.
 *
 *   pnpm embed:backfill [--limit 200] [--court UKSC] [--since 2020-01-01]
 *
 * Resumable: only paragraphs without an embedding are sent. Search-time embedding still happens
 * for cases this hasn't reached, just for their best keyword-matching paragraphs.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: { limit: { type: "string" }, court: { type: "string" }, since: { type: "string" } },
});

async function main() {
  const { db } = await import("../src/db");
  const { sql } = await import("drizzle-orm");
  const { ensureEmbeddings, EMBED_MODEL } = await import("../src/lib/embed");
  const rows = await db.execute<{ uri: string; n: number }>(sql`
    SELECT c.uri, count(e.*)::int AS n
    FROM cases c JOIN elements e ON e.case_uri = c.uri AND e.parent_id IS NULL AND e.kind <> 'heading'
    WHERE (NOT c.embed_complete OR c.embed_model IS DISTINCT FROM ${EMBED_MODEL})
      ${args.court ? sql`AND c.court ILIKE ${args.court + "%"}` : sql``}
      ${args.since ? sql`AND c.date >= ${args.since}` : sql``}
    GROUP BY c.uri, c.opened_at, c.fetched_at
    ORDER BY c.opened_at DESC NULLS LAST, c.fetched_at DESC
    ${args.limit ? sql`LIMIT ${Number(args.limit)}` : sql``}`);
  const total = rows.reduce((s, r) => s + r.n, 0);
  console.log(`${rows.length} cases, ≤${total} paragraphs to embed with ${EMBED_MODEL}`);
  const t0 = Date.now();
  let done = 0;
  for (const [i, r] of rows.entries()) {
    done += await ensureEmbeddings(r.uri);
    if (i % 10 === 9 || i === rows.length - 1) {
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`  ${i + 1}/${rows.length} cases · ${done} paragraphs · ${rate.toFixed(0)}/s`);
    }
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
