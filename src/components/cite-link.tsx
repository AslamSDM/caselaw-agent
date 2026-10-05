"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SourceParagraph } from "@/lib/chat/citations";
import { flashCitation } from "./hash-flash";

interface Preview {
  caseName: string;
  label: string;
  text: string;
}

const cache = new Map<string, Promise<Preview | null>>();

function loadPreview(href: string, label: string): Promise<Preview | null> {
  let p = cache.get(href);
  if (!p) {
    const [path, id] = href.split("#");
    const uri = path.replace(/^\/case\//, "");
    p = fetch(`/api/paragraph?uri=${encodeURIComponent(uri)}&id=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (d ? { caseName: d.caseName, label: d.num ? `¶${String(d.num).replace(/[().\s]/g, "")}` : label, text: d.text } : null))
      .catch(() => null);
    cache.set(href, p);
  }
  return p;
}

/**
 * A citation link into the judgment viewer. Hover (or focus) shows the paragraph; click scrolls to
 * it and highlights it, staying on the page when it is already open.
 */
export function CiteLink({ href, source, children, className }: { href: string; source?: SourceParagraph | null; children: ReactNode; className?: string }) {
  const pathname = usePathname();
  const ref = useRef<HTMLAnchorElement>(null);
  const timer = useRef<number | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const [preview, setPreview] = useState<Preview | null | "loading">(
    source ? { caseName: source.caseName, label: source.label, text: source.text } : null,
  );
  const [path, id] = href.split("#");

  const show = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(380, window.innerWidth - 24);
      const above = r.bottom + 260 > window.innerHeight && r.top > 260;
      setPos({ left: Math.max(12, Math.min(r.left, window.innerWidth - width - 12)), top: above ? r.top - 8 : r.bottom + 8, above });
      if (!preview) {
        setPreview("loading");
        loadPreview(href, String(children)).then((p) => setPreview(p));
      }
    }, 180);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPos(null), 120);
  };
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);

  return (
    <>
      <Link
        ref={ref}
        href={href}
        className={className ?? "text-accent underline decoration-dotted underline-offset-2"}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => {
          setPos(null);
          // same judgment already open: highlight in place instead of navigating
          if (id && decodeURI(path) === decodeURI(pathname)) {
            e.preventDefault();
            window.history.replaceState(window.history.state, "", `#${id}`);
            void flashCitation(pathname, id);
          }
        }}
      >
        {children}
      </Link>
      {pos && preview && (
        <span
          role="tooltip"
          onMouseEnter={() => timer.current && window.clearTimeout(timer.current)}
          onMouseLeave={hide}
          style={{ left: pos.left, top: pos.top, transform: pos.above ? "translateY(-100%)" : undefined }}
          className="fixed z-[60] block w-[min(380px,calc(100vw-24px))] rounded-lg border border-border bg-surface p-3 text-left text-xs font-normal not-italic leading-relaxed text-foreground shadow-xl"
        >
          {preview === "loading" ? (
            <span className="text-muted">Loading passage…</span>
          ) : (
            <>
              <span className="mb-1 block font-semibold">
                {preview.caseName} <span className="font-normal text-muted">· {preview.label}</span>
              </span>
              <span className="block max-h-56 overflow-y-auto whitespace-pre-line text-muted">{preview.text.slice(0, 900)}{preview.text.length > 900 ? "…" : ""}</span>
              <span className="mt-2 block text-[11px] text-accent">Click to jump to the passage</span>
            </>
          )}
        </span>
      )}
    </>
  );
}
