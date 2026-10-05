import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";

/** One stored paragraph's text, for citation previews: GET /api/paragraph?uri=uksc/2021/5&id=para_87 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const uri = url.searchParams.get("uri")?.replace(/^\/+|\/+$/g, "");
  const id = url.searchParams.get("id");
  if (!uri || !id || uri.length > 200 || id.length > 200) return Response.json({ error: "uri and id required" }, { status: 400 });
  const cols = { elementId: schema.elements.elementId, text: schema.elements.text, num: schema.elements.num };
  const [[exact], [kase]] = await Promise.all([
    db.select(cols).from(schema.elements).where(and(eq(schema.elements.caseUri, uri), eq(schema.elements.elementId, id))).limit(1),
    db.select({ name: schema.cases.name, ncn: schema.cases.ncn }).from(schema.cases).where(eq(schema.cases.uri, uri)).limit(1),
  ]);
  let el = exact;
  // "para_87" built from a paragraph number, in a judgment that anchors paragraphs differently
  const n = !el ? id.match(/^para_(\d+)$/)?.[1] : undefined;
  if (n) {
    [el] = await db
      .select(cols)
      .from(schema.elements)
      .where(and(eq(schema.elements.caseUri, uri), isNull(schema.elements.parentId), sql`regexp_replace(coalesce(${schema.elements.num}, ''), '[^0-9]', '', 'g') = ${n}`))
      .limit(1);
  }
  if (!el) return Response.json({ error: "not stored" }, { status: 404 });
  return Response.json(
    { caseName: kase?.name ?? uri, ncn: kase?.ncn ?? null, num: el.num, elementId: el.elementId, text: el.text.slice(0, 1500) },
    { headers: { "Cache-Control": "private, max-age=3600" } },
  );
}
