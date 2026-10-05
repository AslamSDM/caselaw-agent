"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, generateId, type UIMessage } from "ai";
import Link from "next/link";
import { checkQuotes, citedParagraphs, resolveCitation, sourcesFromParts, type SourceParagraph } from "@/lib/chat/citations";
import { CiteLink } from "./cite-link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

const TOOL_LABEL: Record<string, string> = {
  read_case: "Reading",
  get_citations: "Checking citations of",
  search_cases: "Searching for",
};

interface ChatSummary {
  id: string;
  title: string;
  updatedAt: string;
  turns: number;
}

/**
 * Follow-up questions about a search's results (searchId) or one judgment (caseUri).
 * Conversations are saved server-side after every answer; History lists earlier ones for the
 * same search or judgment.
 */
export function FollowUpChat({
  searchId,
  caseUri,
  suggestions = [],
  variant = "inline",
}: {
  searchId?: number | null;
  caseUri?: string;
  suggestions?: string[];
  /** "sidebar": fills a tall column with its own scrolling, and can expand to a wide panel */
  variant?: "inline" | "sidebar";
}) {
  const [session, setSession] = useState<{ id: string; messages: UIMessage[] }>(() => ({ id: generateId(), messages: [] }));
  const [expanded, setExpanded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ChatSummary[] | null>(null);

  const scopeQuery = new URLSearchParams({
    ...(searchId ? { searchId: String(searchId) } : {}),
    ...(caseUri ? { caseUri } : {}),
  }).toString();

  const loadHistory = useCallback(async () => {
    const r = await fetch(`/api/chats?${scopeQuery}`).catch(() => null);
    setHistory(r?.ok ? ((await r.json()) as { chats: ChatSummary[] }).chats : []);
  }, [scopeQuery]);

  const openChat = useCallback(async (id: string, isCancelled: () => boolean = () => false) => {
    const r = await fetch(`/api/chats/${encodeURIComponent(id)}`).catch(() => null);
    if (!r?.ok || isCancelled()) return;
    const { messages } = (await r.json()) as { messages: UIMessage[] };
    setSession({ id, messages });
    setHistoryOpen(false);
  }, []);

  // open the most recent conversation for this search/judgment, if there is one
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await fetch(`/api/chats?${scopeQuery}`).catch(() => null);
      const chats = r?.ok ? ((await r.json()) as { chats: ChatSummary[] }).chats : [];
      if (cancelled) return;
      setHistory(chats);
      if (chats[0]) await openChat(chats[0].id, () => cancelled);
    })();
    return () => {
      cancelled = true;
    };
  }, [scopeQuery, openChat]);

  const deleteChat = async (id: string) => {
    await fetch(`/api/chats/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    if (id === session.id) setSession({ id: generateId(), messages: [] });
    await loadHistory();
  };

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setExpanded(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const sidebar = variant === "sidebar";
  const frame = expanded
    ? "fixed inset-y-0 right-0 z-50 flex h-dvh w-[min(760px,100vw)] flex-col rounded-none border-l border-border bg-surface p-5 shadow-2xl"
    : sidebar
      ? "flex h-[calc(100vh-11rem)] min-h-[420px] flex-col rounded-lg border border-border bg-surface p-4"
      : "rounded-lg border border-border bg-surface p-4";
  const scrollArea = expanded || sidebar ? "min-h-0 flex-1 overflow-y-auto pr-1" : "";
  const smallBtn = "rounded border border-border px-2 py-0.5 text-xs text-muted hover:border-accent hover:text-foreground";

  return (
    <>
      {expanded && (
        <button type="button" aria-label="Close chat" onClick={() => setExpanded(false)} className="fixed inset-0 z-40 cursor-default bg-black/30" />
      )}
      <section className={`${frame} relative text-sm`}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className={`font-semibold ${expanded ? "text-base" : ""}`}>Ask a follow-up</h2>
          <div className="flex gap-1.5">
            <button
              type="button"
              className={smallBtn}
              aria-expanded={historyOpen}
              onClick={() => {
                setHistoryOpen((x) => !x);
                void loadHistory();
              }}
            >
              History{history?.length ? ` (${history.length})` : ""}
            </button>
            <button type="button" className={smallBtn} onClick={() => setSession({ id: generateId(), messages: [] })}>
              New
            </button>
            {(sidebar || expanded) && (
              <button type="button" onClick={() => setExpanded((x) => !x)} className={smallBtn}>
                {expanded ? "Close ✕" : "Expand ⤢"}
              </button>
            )}
          </div>
        </div>

        {historyOpen && (
          <div className="mb-3 max-h-64 overflow-y-auto rounded border border-border bg-background p-2">
            {!history ? (
              <p className="text-xs text-muted">Loading…</p>
            ) : history.length === 0 ? (
              <p className="text-xs text-muted">No earlier chats here yet. Every conversation is saved after each answer.</p>
            ) : (
              <ul className="space-y-1">
                {history.map((c) => (
                  <li key={c.id} className={`flex items-start gap-2 rounded px-2 py-1.5 ${c.id === session.id ? "bg-surface" : ""}`}>
                    <button type="button" onClick={() => void openChat(c.id)} className="min-w-0 flex-1 text-left hover:underline">
                      <span className="block truncate">{c.title}</span>
                      <span className="text-[11px] text-muted">
                        {new Date(c.updatedAt).toLocaleString()} · {c.turns} question{c.turns === 1 ? "" : "s"}
                      </span>
                    </button>
                    <button type="button" aria-label={`Delete chat: ${c.title}`} onClick={() => void deleteChat(c.id)} className="text-xs text-muted hover:text-red-600">
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Link href="/chats" className="mt-2 block text-right text-xs text-accent underline">
              All chats →
            </Link>
          </div>
        )}

        <ChatSession
          key={session.id}
          chatId={session.id}
          initialMessages={session.messages}
          searchId={searchId}
          caseUri={caseUri}
          suggestions={suggestions}
          scrollArea={scrollArea}
          onSaved={() => void loadHistory()}
        />
      </section>
    </>
  );
}

/** One conversation (remounted per chat id so switching chats resets the hook cleanly). */
function ChatSession({
  chatId,
  initialMessages,
  searchId,
  caseUri,
  suggestions,
  scrollArea,
  onSaved,
}: {
  chatId: string;
  initialMessages: UIMessage[];
  searchId?: number | null;
  caseUri?: string;
  suggestions: string[];
  scrollArea: string;
  onSaved: () => void;
}) {
  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat", body: () => ({ searchId: searchId ?? null, caseUri: caseUri ?? null }) }),
    [searchId, caseUri],
  );
  const { messages, sendMessage, status, stop, error } = useChat({ id: chatId, messages: initialMessages, transport, onFinish: onSaved });
  const [input, setInput] = useState("");
  const busy = status === "submitted" || status === "streaming";
  // every paragraph the agent has read in this conversation (later answers may cite earlier reads)
  const sources = useMemo(
    () => messages.flatMap((m) => sourcesFromParts(m.parts as { type: string; state?: string; output?: unknown }[])),
    [messages],
  );
  const scroller = useRef<HTMLDivElement>(null);

  // keep the newest message in view while answers stream in
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const send = (text: string) => {
    if (!text.trim() || busy) return;
    sendMessage({ text: text.trim() });
    setInput("");
  };

  return (
    <>
      <div ref={scroller} className={scrollArea}>
        {messages.length === 0 && suggestions.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {suggestions.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => send(q)}
                className="rounded-full border border-border px-3 py-1 text-xs text-muted hover:border-accent hover:text-foreground"
              >
                {q}
              </button>
            ))}
          </div>
        )}
        <div className="space-y-3">
          {messages.map((m) => (
            <Message key={m.id} m={m} sources={sources} />
          ))}
          {status === "submitted" && <p className="text-xs text-muted">Thinking…</p>}
          {error && <p className="text-red-600">Chat failed: {error.message}</p>}
        </div>
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          id={`chat-input-${searchId ?? caseUri ?? "x"}`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={caseUri ? "e.g. What did the court decide on causation?" : "e.g. Compare how these cases treat foreseeability"}
          className="min-w-0 flex-1 rounded border border-border bg-background px-3 py-2 outline-none focus:border-accent"
        />
        {busy ? (
          <button type="button" onClick={() => stop()} className="rounded border border-border px-3 py-2 hover:border-accent">
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()} className="rounded bg-accent px-3 py-2 text-background disabled:opacity-40">
            Ask
          </button>
        )}
      </form>
      <p className="mt-2 text-xs text-muted">Answers quote the judgments with paragraph links. Saved to History. Not legal advice.</p>
    </>
  );
}

function Message({ m, sources }: { m: UIMessage; sources: SourceParagraph[] }) {
  if (m.role === "user") {
    const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return <p className="rounded bg-background px-3 py-2 font-medium">{text}</p>;
  }
  return (
    <div className="space-y-2">
      {m.parts.map((p, i) => {
        if (p.type === "text") return <Markdown key={i} text={p.text} sources={sources} />;
        if (p.type.startsWith("tool-") && "state" in p) {
          const name = p.type.slice(5);
          const input = ("input" in p ? p.input : {}) as { uri?: string; query?: string; question?: string } | undefined;
          const target = input?.uri ?? input?.query ?? "";
          const done = p.state === "output-available";
          const failed = p.state === "output-error";
          return (
            <p key={i} className="text-xs text-muted">
              {failed ? "✗" : done ? "✓" : "…"} {TOOL_LABEL[name] ?? name} <span className="font-mono">{target}</span>
              {input?.question ? ` — ${input.question}` : ""}
            </p>
          );
        }
        return null;
      })}
      <Citations text={m.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n")} sources={sources} />
    </div>
  );
}

/** Paragraphs cited in an answer, with each quote checked against the text the agent read. */
function Citations({ text, sources }: { text: string; sources: SourceParagraph[] }) {
  const cited = citedParagraphs(text, sources);
  const quotes = checkQuotes(text, sources);
  if (!cited.length && !quotes.length) return null;
  const unverified = quotes.filter((q) => !q.found);
  return (
    <details open className="rounded border border-border bg-background px-3 py-2 text-xs">
      <summary className="cursor-pointer text-muted">
        {cited.length} paragraph{cited.length === 1 ? "" : "s"} cited
        {quotes.length > 0 && (
          <>
            {" · "}
            <span className={unverified.length ? "text-red-600" : ""}>
              {quotes.length - unverified.length}/{quotes.length} quotes found word-for-word
            </span>
          </>
        )}
      </summary>
      <ol className="mt-2 space-y-1.5">
        {cited.map((c) => (
          <li key={c.href} className="flex gap-2">
            <CiteLink href={c.href} source={c.source} className="shrink-0 font-medium text-accent underline">
              {c.label}
            </CiteLink>
            <span className="min-w-0 text-muted">
              {c.source ? `${c.source.text.slice(0, 160)}${c.source.text.length > 160 ? "…" : ""}` : "⚠ not among the paragraphs the assistant read"}
            </span>
          </li>
        ))}
      </ol>
      {unverified.length > 0 && (
        <div className="mt-2 border-t border-border pt-2">
          <p className="font-medium text-red-600">Not found word-for-word (check before relying on it):</p>
          <ul className="mt-1 space-y-1">
            {unverified.map((q) => (
              <li key={q.quote} className="text-muted">“{q.quote.slice(0, 200)}{q.quote.length > 200 ? "…" : ""}”</li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}

/** Minimal markdown: paragraphs, "- " bullets, > quotes, **bold**, *italic*, [links](/case/…). */
function Markdown({ text, sources }: { text: string; sources: SourceParagraph[] }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="space-y-2 leading-relaxed">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ""), sources)}</li>
              ))}
            </ul>
          );
        }
        if (lines.every((l) => l.startsWith(">"))) {
          return (
            <blockquote key={i} className="border-l-2 border-accent pl-3 italic">
              {inline(lines.map((l) => l.replace(/^>\s?/, "")).join(" "), sources)}
            </blockquote>
          );
        }
        if (/^#{1,4}\s/.test(b)) return <p key={i} className="font-semibold">{inline(b.replace(/^#+\s/, ""), sources)}</p>;
        return <p key={i}>{inline(b, sources)}</p>;
      })}
    </div>
  );
}

function inline(s: string, sources: SourceParagraph[]): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push(s.slice(last, m.index));
    if (m[1]) {
      const href = m[2];
      out.push(
        href.startsWith("/case/") && href.includes("#") ? (
          (() => {
            const source = resolveCitation(href, m[1], sources);
            return (
              <CiteLink key={out.length} href={source?.href ?? href} source={source}>
                {m[1]}
              </CiteLink>
            );
          })()
        ) : href.startsWith("/") ? (
          <Link key={out.length} href={href} className="text-accent underline">
            {m[1]}
          </Link>
        ) : (
          <a key={out.length} href={href} target="_blank" rel="noreferrer" className="text-accent underline">
            {m[1]}
          </a>
        ),
      );
    } else if (m[3]) out.push(<strong key={out.length}>{m[3]}</strong>);
    else if (m[4]) out.push(<em key={out.length}>{m[4]}</em>);
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
