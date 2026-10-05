/** Chat history persistence (chats table). */
import type { UIMessage } from "ai";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";

export const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface ChatScope {
  searchId?: number | null;
  caseUri?: string | null;
}

export interface ChatSummary {
  id: string;
  title: string;
  searchId: number | null;
  caseUri: string | null;
  updatedAt: Date;
  turns: number;
}

const firstUserText = (messages: UIMessage[]) =>
  messages
    .find((m) => m.role === "user")
    ?.parts.map((p) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .trim() ?? "";

export async function saveChat(id: string, scope: ChatScope, messages: UIMessage[]) {
  if (!CHAT_ID.test(id) || !messages.length) return;
  const title = firstUserText(messages).slice(0, 120) || "Untitled chat";
  const values = { id, searchId: scope.searchId ?? null, caseUri: scope.caseUri ?? null, title, messages, updatedAt: new Date() };
  await db
    .insert(schema.chats)
    .values(values)
    .onConflictDoUpdate({ target: schema.chats.id, set: { messages, title, updatedAt: values.updatedAt } });
}

export async function loadChat(id: string): Promise<{ messages: UIMessage[]; searchId: number | null; caseUri: string | null } | null> {
  if (!CHAT_ID.test(id)) return null;
  const [row] = await db.select().from(schema.chats).where(eq(schema.chats.id, id));
  return row ? { messages: row.messages as UIMessage[], searchId: row.searchId, caseUri: row.caseUri } : null;
}

export async function deleteChat(id: string) {
  if (CHAT_ID.test(id)) await db.delete(schema.chats).where(eq(schema.chats.id, id));
}

/** Chats for exactly this scope (a search, a judgment, or a judgment opened from a search); all chats when no scope. */
export async function listChats(scope: ChatScope, limit = 50): Promise<ChatSummary[]> {
  const where: SQL[] = [];
  if (scope.searchId != null || scope.caseUri) {
    where.push(scope.searchId != null ? eq(schema.chats.searchId, scope.searchId) : isNull(schema.chats.searchId));
    where.push(scope.caseUri ? eq(schema.chats.caseUri, scope.caseUri) : isNull(schema.chats.caseUri));
  }
  const rows = await db
    .select()
    .from(schema.chats)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(schema.chats.updatedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    searchId: r.searchId,
    caseUri: r.caseUri,
    updatedAt: r.updatedAt,
    turns: (r.messages as UIMessage[]).filter((m) => m.role === "user").length,
  }));
}
