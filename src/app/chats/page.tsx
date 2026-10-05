import Link from "next/link";
import { inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { listChats } from "@/lib/chat/store";

export const dynamic = "force-dynamic";

/** Every saved follow-up chat, newest first, linking back to where it was asked. */
export default async function ChatsPage() {
  const chats = await listChats({}, 200);
  const searchIds = [...new Set(chats.map((c) => c.searchId).filter((x): x is number => x !== null))];
  const caseUris = [...new Set(chats.map((c) => c.caseUri).filter((x): x is string => Boolean(x)))];
  const [searches, cases] = await Promise.all([
    searchIds.length ? db.select({ id: schema.searches.id, query: schema.searches.query }).from(schema.searches).where(inArray(schema.searches.id, searchIds)) : [],
    caseUris.length ? db.select({ uri: schema.cases.uri, name: schema.cases.name }).from(schema.cases).where(inArray(schema.cases.uri, caseUris)) : [],
  ]);
  const queryOf = new Map(searches.map((s) => [s.id, s.query]));
  const nameOf = new Map(cases.map((c) => [c.uri, c.name]));

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Chat history</h1>
      <p className="mt-1 text-sm text-muted">Follow-up conversations, saved after every answer. Open one to continue it where it was asked.</p>
      {chats.length === 0 ? (
        <p className="mt-6 text-muted">No chats yet. Ask a follow-up under search results or on a judgment.</p>
      ) : (
        <ul className="mt-6 divide-y divide-border rounded-lg border border-border bg-surface">
          {chats.map((c) => {
            const href = c.caseUri ? `/case/${c.caseUri}${c.searchId ? `?search=${c.searchId}` : ""}` : `/?q=${encodeURIComponent(queryOf.get(c.searchId!) ?? "")}`;
            return (
              <li key={c.id} className="px-4 py-3">
                <Link href={href} className="font-medium hover:underline">
                  {c.title}
                </Link>
                <p className="mt-0.5 text-xs text-muted">
                  {c.caseUri ? `On ${nameOf.get(c.caseUri) ?? c.caseUri}` : `About the search “${queryOf.get(c.searchId!) ?? "?"}”`} · {c.turns} question
                  {c.turns === 1 ? "" : "s"} · {c.updatedAt.toLocaleString("en-GB")}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
