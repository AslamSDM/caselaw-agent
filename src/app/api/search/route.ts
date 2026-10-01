import { z } from "zod";
import { runSearch } from "@/lib/search/pipeline";
import { llmConfigured } from "@/lib/llm";
import { isAreaId } from "@/lib/areas";
import { normalizeRange, parseDateInput, type DateRange } from "@/lib/dates";

export const maxDuration = 60;

const body = z.object({
  query: z.string().trim().min(2).max(300),
  areas: z.array(z.string().refine(isAreaId, "unknown area")).max(10).optional(),
  // omitted = infer from the query; null = ignore dates; YYYY, YYYY-MM or YYYY-MM-DD per end
  dates: z
    .object({ from: z.string().optional(), to: z.string().optional() })
    .nullable()
    .optional(),
});

/** Streams SearchEvents as NDJSON. */
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return Response.json({ error: `${issue.path.join(".") || "body"}: ${issue.message}` }, { status: 400 });
  }
  if (!llmConfigured()) {
    return Response.json({ error: "No LLM configured: set OPENROUTER_API_KEY, ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY" }, { status: 500 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: unknown) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        for await (const event of runSearch(parsed.data.query, { areas: parsed.data.areas, dates: toRange(parsed.data.dates) }, req.signal)) send(event);
      } catch (err) {
        if (!req.signal.aborted) {
          console.error("[api/search]", err);
          send({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function toRange(d: { from?: string; to?: string } | null | undefined): DateRange | null | undefined {
  if (d === undefined) return undefined;
  if (d === null) return null;
  return normalizeRange({ from: parseDateInput(d.from, "from"), to: parseDateInput(d.to, "to") });
}
