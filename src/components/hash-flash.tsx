"use client";

import { useEffect } from "react";

const FLASH_MS = 2400;

/** Scroll a judgment passage into view and highlight it briefly (re-triggers on repeat clicks). */
export function flashElement(id: string, scroll = true): boolean {
  const el = document.getElementById(id);
  if (!el) return false;
  if (scroll) el.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  el.classList.remove("cite-flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("cite-flash");
  window.setTimeout(() => el.classList.remove("cite-flash"), FLASH_MS);
  return true;
}

/**
 * Like flashElement, but when the anchor does not exist (a "para_87" link in a judgment whose
 * paragraphs are anchored differently) asks the server which element paragraph 87 is.
 */
export async function flashCitation(pathname: string, id: string): Promise<string | null> {
  if (flashElement(id)) return id;
  if (!/^para_\d+$/.test(id)) return null;
  const uri = pathname.replace(/^\/case\//, "");
  const r = await fetch(`/api/paragraph?uri=${encodeURIComponent(uri)}&id=${encodeURIComponent(id)}`).catch(() => null);
  const d = r?.ok ? ((await r.json()) as { elementId?: string }) : null;
  if (d?.elementId && flashElement(d.elementId)) {
    window.history.replaceState(window.history.state, "", `#${d.elementId}`);
    return d.elementId;
  }
  return null;
}

/**
 * Highlights the passage named in the URL fragment: on arrival (e.g. from a citation link on
 * another page) and whenever the fragment changes. Client-side navigation uses pushState, which
 * the CSS :target selector does not see, so this does it explicitly.
 */
export function HashFlash() {
  useEffect(() => {
    const run = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id) return;
      // the target may render a frame later after client navigation
      let tries = 0;
      const attempt = () => {
        if (flashElement(id)) return;
        if (++tries > 10) return void flashCitation(window.location.pathname, id);
        window.setTimeout(attempt, 100);
      };
      attempt();
    };
    run();
    window.addEventListener("hashchange", run);
    return () => window.removeEventListener("hashchange", run);
  }, []);
  return null;
}
