/**
 * Paragraph embeddings. Dev: local Ollama (EMBED_MODEL, default nomic-embed-text, 768-d).
 * Vectors live in elements.embedding (pgvector) for top-level paragraphs; cases.embed_model
 * records which model produced them so a model change re-embeds instead of mixing spaces.
 *
 * Embedding is incremental: search time embeds only the paragraphs it is about to rank
 * (missing ones), and scripts/embed-backfill.ts embeds whole cases for cache-wide search.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { EMBED_DIM } from "@/db/schema";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
export const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";
const BATCH = 32;
/** Ollama runs nomic with a 2048-token window; cap input so long paragraphs truncate predictably */
const MAX_CHARS = 6000;

export function embeddingsEnabled(): boolean {
  return process.env.EMBED_ENABLED !== "false";
}

/** nomic-embed-text expects task prefixes; other models get raw text. */
function prefix(kind: "query" | "document", text: string): string {
  if (!EMBED_MODEL.startsWith("nomic")) return text;
  return `${kind === "query" ? "search_query" : "search_document"}: ${text}`;
}

async function ollamaEmbed(inputs: string[], signal?: AbortSignal): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += BATCH) {
    const res = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: inputs.slice(i, i + BATCH), truncate: true }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Ollama embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const { embeddings } = (await res.json()) as { embeddings: number[][] };
    if (embeddings[0]?.length !== EMBED_DIM) {
      throw new Error(`${EMBED_MODEL} returns ${embeddings[0]?.length}-d vectors; schema expects ${EMBED_DIM}`);
    }
    out.push(...embeddings);
  }
  return out;
}

export async function embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
  const [v] = await ollamaEmbed([prefix("query", text)], signal);
  return v;
}

export const toVectorLiteral = (v: number[]) => `[${v.join(",")}]`;

/** Clear vectors made by a different model, so they are re-embedded rather than compared. */
async function resetIfModelChanged(caseUri: string) {
  const [c] = await db
    .select({ embedModel: schema.cases.embedModel })
    .from(schema.cases)
    .where(eq(schema.cases.uri, caseUri));
  if (c?.embedModel && c.embedModel !== EMBED_MODEL) {
    await db.update(schema.elements).set({ embedding: null }).where(eq(schema.elements.caseUri, caseUri));
    await db.update(schema.cases).set({ embedModel: null, embedComplete: false }).where(eq(schema.cases.uri, caseUri));
  }
}

/**
 * Ensure the given top-level elements of a case have embeddings (only missing ones are sent to
 * the model). Omit `elementIds` to embed the whole case. Returns how many were embedded.
 */
export async function ensureEmbeddings(caseUri: string, elementIds?: string[], signal?: AbortSignal): Promise<number> {
  await resetIfModelChanged(caseUri);
  const missing = await db
    .select({ elementId: schema.elements.elementId, text: schema.elements.text })
    .from(schema.elements)
    .where(
      and(
        eq(schema.elements.caseUri, caseUri),
        isNull(schema.elements.parentId),
        isNull(schema.elements.embedding),
        sql`${schema.elements.kind} <> 'heading'`,
        elementIds ? inArray(schema.elements.elementId, elementIds.length ? elementIds : [""]) : undefined,
      ),
    );
  if (missing.length) {
    const vectors = await ollamaEmbed(missing.map((m) => prefix("document", m.text.slice(0, MAX_CHARS))), signal);
    // one UPDATE per batch via a VALUES list (drizzle expands JS arrays into separate params)
    for (let i = 0; i < missing.length; i += 200) {
      const rows = missing.slice(i, i + 200).map((m, j) => sql`(${m.elementId}, ${toVectorLiteral(vectors[i + j])}::vector)`);
      await db.execute(sql`
        UPDATE elements e SET embedding = v.vec
        FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(id, vec)
        WHERE e.case_uri = ${caseUri} AND e.element_id = v.id
      `);
    }
  }
  const [{ remaining }] = await db.execute<{ remaining: number }>(sql`
    SELECT count(*)::int AS remaining FROM elements
    WHERE case_uri = ${caseUri} AND parent_id IS NULL AND kind <> 'heading' AND embedding IS NULL
  `);
  await db
    .update(schema.cases)
    .set({ embedModel: EMBED_MODEL, embedComplete: Number(remaining) === 0 })
    .where(eq(schema.cases.uri, caseUri));
  return missing.length;
}
