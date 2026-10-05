import { deleteChat, loadChat } from "@/lib/chat/store";

export async function GET(_req: Request, ctx: RouteContext<"/api/chats/[id]">) {
  const { id } = await ctx.params;
  const chat = await loadChat(id);
  if (!chat) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(chat, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/chats/[id]">) {
  const { id } = await ctx.params;
  await deleteChat(id);
  return new Response(null, { status: 204 });
}
