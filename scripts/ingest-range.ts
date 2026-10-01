/**
 * Bulk-ingest every TNA judgment in a date range into the local DB (cases + elements + citations).
 *
 *   pnpm ingest --from 2025-10-01 --to 2026-10-01 [--exclude-court Immigration] [--court "High Court"]
 *               [--concurrency 4] [--dry-run]
 *
 * Defaults to the past year. Resumable: cases already stored with the same content hash as the
 * atom feed entry are skipped, and search pages are cached for 24h. Uses the shared TNA rate
 * limiter, so it is safe to run alongside the app (it will just slow the app's searches down).
 *
 * ⚠️ Licence: the Open Justice Licence does not cover bulk computational analysis. See plan.md §1.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    from: { type: "string" },
    to: { type: "string" },
    court: { type: "string", multiple: true },
    "exclude-court": { type: "string", multiple: true },
    concurrency: { type: "string", default: "4" },
    "dry-run": { type: "boolean", default: false },
  },
});

const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = new Date();
const from = args.from ?? iso(new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate())));
const to = args.to ?? iso(today);
const include = (args.court ?? []).map((s) => s.toLowerCase());
const exclude = (args["exclude-court"] ?? []).map((s) => s.toLowerCase());
const concurrency = Math.max(1, Number(args.concurrency));
const PER_PAGE = 50;

function courtWanted(court: string | null) {
  const c = (court ?? "").toLowerCase();
  if (include.length && !include.some((s) => c.includes(s))) return false;
  return !exclude.some((s) => c.includes(s));
}

async function main() {
  const { inArray } = await import("drizzle-orm");
  const { db, schema } = await import("../src/db");
  const { searchTna, fetchJudgmentXml } = await import("../src/lib/tna/client");
  const { parseJudgment } = await import("../src/lib/tna/parser");
  const { saveParsedCase } = await import("../src/lib/cases/store");

  console.log(`ingest ${from} → ${to}` + (include.length ? ` court∋${include}` : "") + (exclude.length ? ` court∌${exclude}` : "") + (args["dry-run"] ? " (dry run)" : ""));

  const stats = { seen: 0, filtered: 0, skipped: 0, saved: 0, missing: 0, failed: 0 };
  const failures: string[] = [];
  const started = Date.now();

  // one entry at a time per worker; the shared limiter paces the actual requests
  async function ingest(uri: string, cachedClassified: { areas: string[] } | undefined) {
    try {
      // the shared limiter gives up after ~60s; a bulk run can afford to wait out other users
      let xml: string | null = null;
      for (let attempt = 0; ; attempt++) {
        try {
          xml = await fetchJudgmentXml(uri);
          break;
        } catch (e) {
          if (attempt >= 5 || !String(e).includes("budget exhausted")) throw e;
          await new Promise((r) => setTimeout(r, 30_000));
        }
      }
      if (!xml) return void stats.missing++;
      const parsed = parseJudgment(xml);
      parsed.uri ||= uri;
      await saveParsedCase(parsed, uri, cachedClassified?.areas);
      stats.saved++;
    } catch (e) {
      stats.failed++;
      failures.push(`${uri}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // TNA's rel="last" link is unreliable, so page until an empty page comes back
  for (let page = 1; ; page++) {
    const res = await searchTna({ dates: { from, to }, perPage: PER_PAGE, page, order: "-date" });
    if (!res.entries.length) break;
    stats.seen += res.entries.length;

    const wanted = res.entries.filter((e) => courtWanted(e.court));
    stats.filtered += res.entries.length - wanted.length;

    const existing = wanted.length
      ? await db
          .select({ uri: schema.cases.uri, contentHash: schema.cases.contentHash, areas: schema.cases.areas, areasClassified: schema.cases.areasClassified })
          .from(schema.cases)
          .where(inArray(schema.cases.uri, wanted.map((e) => e.uri)))
      : [];
    const byUri = new Map(existing.map((r) => [r.uri, r]));
    const todo = wanted.filter((e) => {
      const row = byUri.get(e.uri);
      return !(row && e.contentHash && row.contentHash === e.contentHash);
    });
    stats.skipped += wanted.length - todo.length;

    if (!args["dry-run"]) {
      const queue = [...todo];
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          for (let e; (e = queue.shift()); ) {
            const row = byUri.get(e.uri);
            await ingest(e.uri, row?.areasClassified ? { areas: row.areas } : undefined);
          }
        }),
      );
    }

    const mins = ((Date.now() - started) / 60000).toFixed(1);
    const last = res.entries.at(-1)?.date;
    console.log(
      `page ${page} (${last}) seen=${stats.seen} saved=${stats.saved} skipped=${stats.skipped} filtered=${stats.filtered} missing=${stats.missing} failed=${stats.failed} · ${mins} min`,
    );
    if (res.entries.length < PER_PAGE) break;
  }

  console.log("done", stats);
  if (failures.length) {
    console.log(`${failures.length} failures (re-run to retry):`);
    failures.slice(0, 50).forEach((f) => console.log("  ", f));
  }
  process.exit(stats.failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
