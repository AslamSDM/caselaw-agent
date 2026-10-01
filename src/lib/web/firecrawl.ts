/**
 * Web search via Firecrawl. Dev points FIRECRAWL_API_URL at the self-hosted instance in podman
 * (no key); production uses the Firecrawl cloud API (FIRECRAWL_API_URL unset → api.firecrawl.dev,
 * FIRECRAWL_API_KEY required). Same /v2 API either way.
 */
import Firecrawl from "@mendable/firecrawl-js";

export interface WebResult {
  url: string;
  title: string;
  description: string;
}

let client: Firecrawl | null = null;

export function firecrawlConfigured(): boolean {
  if (process.env.WEB_ENRICH_ENABLED === "false") return false;
  return Boolean(process.env.FIRECRAWL_API_URL || process.env.FIRECRAWL_API_KEY);
}

function getClient(): Firecrawl {
  if (client) return client;
  const apiUrl = process.env.FIRECRAWL_API_URL || undefined;
  const apiKey = process.env.FIRECRAWL_API_KEY || undefined;
  if (!apiUrl && !apiKey) throw new Error("Firecrawl not configured: set FIRECRAWL_API_URL (dev) or FIRECRAWL_API_KEY (prod)");
  // Self-hosted Firecrawl ignores the key but the SDK requires one when talking to the cloud.
  client = new Firecrawl({ apiKey: apiKey ?? "self-hosted", apiUrl: apiUrl ?? "https://api.firecrawl.dev" });
  return client;
}

export async function webSearch(query: string, opts: { limit?: number; timeoutMs?: number } = {}): Promise<WebResult[]> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const res = await getClient().search(query, {
    limit: opts.limit ?? 8,
    sources: ["web"],
    country: "GB",
    timeout: timeoutMs,
  });
  const web = (res.web ?? []) as Array<{ url?: string; title?: string; description?: string }>;
  return web
    .filter((r) => r.url)
    .map((r) => ({ url: r.url!, title: r.title ?? "", description: r.description ?? "" }));
}
