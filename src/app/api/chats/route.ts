import { listChats } from "@/lib/chat/store";

/** GET /api/chats?searchId=12&caseUri=uksc/2021/5 → saved chats for that scope (all chats when neither is given). */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const searchId = sp.get("searchId") ? Number(sp.get("searchId")) : null;
  const caseUri = sp.get("caseUri")?.slice(0, 200) || null;
  if (searchId !== null && !Number.isInteger(searchId)) return Response.json({ error: "bad searchId" }, { status: 400 });
  const chats = await listChats({ searchId, caseUri });
  return Response.json({ chats }, { headers: { "Cache-Control": "no-store" } });
}
