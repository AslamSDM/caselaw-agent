/** Query the local index directly (no LLM, no TNA): pnpm local-search "unfair dismissal whistleblowing" */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const query = process.argv.slice(2).join(" ");
  if (!query) throw new Error('usage: pnpm local-search "<query>"');
  const { searchLocal, vectorParagraphHits } = await import("../src/lib/search/local");
  const { embedQuery } = await import("../src/lib/embed");
  const { fuseCandidates } = await import("../src/lib/search/fusion");
  const t = Date.now();
  const res = await searchLocal({ original: query, variants: [query], ftsTerms: [], filters: {}, dates: null, datesReason: null }, null, await embedQuery(query));
  console.log(`${Date.now() - t}ms`);
  for (const l of res.lists) console.log(`${l.label}: ${l.entries.length} (total ~${l.estimatedTotal})`);
  for (const c of fuseCandidates(res.lists, 10)) {
    const hits = res.queryVec ? await vectorParagraphHits(c.uri, res.queryVec, 2) : new Map();
    const best = [...hits].map(([id, s]) => `${id}@${s.toFixed(2)}`).join(" ");
    console.log(`${c.score.toFixed(2)}  ${c.date}  ${c.court}  ${c.name.slice(0, 70)}  [${c.matchedBy.join(", ")}]  ${best}`);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
