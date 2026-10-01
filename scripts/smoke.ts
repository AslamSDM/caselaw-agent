/** Non-LLM smoke test: TNA search, fetch+store, paragraph retrieval, Firecrawl search. */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { searchTna } = await import("../src/lib/tna/client");
  const { ensureCase, getElements } = await import("../src/lib/cases/store");
  const { retrieveParagraphs } = await import("../src/lib/search/retrieve");
  const { webSearch, firecrawlConfigured } = await import("../src/lib/web/firecrawl");

  let t = Date.now();
  const page = await searchTna({ query: "jaguar battery" });
  console.log(`TNA search: ${page.entries.length} entries, ~${page.estimatedTotal} total, cached=${page.cached} (${Date.now() - t}ms)`);
  page.entries.slice(0, 3).forEach((e) => console.log("  ", e.uri, "|", e.ncn, "|", e.name));

  t = Date.now();
  const c = await ensureCase("ewhc/ch/2016/52");
  console.log(`ensureCase: ${c?.row.name} fromCache=${c?.fromCache} (${Date.now() - t}ms)`);
  const els = await getElements("ewhc/ch/2016/52");
  const ctx = await retrieveParagraphs("ewhc/ch/2016/52", els, ["jaguar battery leak", "battery pack", "leak", "jaguar"]);
  console.log(`retrieve: ${ctx.hitCount} hit paragraphs → ${ctx.topLevel.length} chosen:`, ctx.topLevel.map((e) => e.elementId).join(", "));

  if (firecrawlConfigured()) {
    t = Date.now();
    const web = await webSearch("jaguar I-Pace battery fire UK court judgment", { limit: 5 });
    console.log(`firecrawl: ${web.length} results (${Date.now() - t}ms)`);
    web.slice(0, 3).forEach((r) => console.log("  ", r.url));
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
