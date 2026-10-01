/**
 * Akoma Ntoso (LegalDocML) judgment parser for TNA Find Case Law `data.xml`.
 *
 * Produces case metadata, a flat list of elements (paragraphs with nested sub-paragraphs and quoted
 * blocks as their own rows, linked by parentId), and citations taken from `<ref uk:type=…>` markup.
 */
import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import { findAll, findOne, getAttributeValue, textContent } from "domutils";
import { tidyWhitespace } from "../text";
import type { ElementPart } from "@/db/schema";

export const TNA_BASE = "https://caselaw.nationalarchives.gov.uk";

export interface ParsedElement {
  elementId: string;
  parentId: string | null;
  kind: "heading" | "paragraph" | "subparagraph" | "quote_block" | "block";
  num: string | null;
  ord: number;
  text: string;
  parts: ElementPart[];
}

export interface ParsedCitation {
  fromElementId: string | null;
  type: "case" | "legislation";
  toNcn: string | null;
  toUri: string | null;
  toLegislation: string | null;
  href: string | null;
  raw: string;
}

export interface ParsedCase {
  uri: string;
  ncn: string | null;
  name: string;
  court: string | null;
  date: string | null;
  judges: string[];
  parties: string[];
  anonymised: boolean;
  contentHash: string | null;
  elements: ParsedElement[];
  citations: ParsedCitation[];
}

const QUOTE_TAGS = new Set(["embeddedStructure", "blockQuote", "quotedStructure", "quotedText"]);
const BLOCK_TAGS = new Set(["p", "tr", "li", "blockList", "item", "intro", "wrapUp", "heading", "subheading", "table", "block"]);
const SKIP_TAGS = new Set(["num", "authorialNote", "img", "meta", "header"]);
const CONTAINER_TAGS = new Set(["judgmentBody", "decision", "introduction", "background", "motivation", "arguments", "remedies", "conclusions", "body", "level", "hcontainer", "section", "division", "part", "chapter"]);

const isEl = (n: ChildNode): n is Element => n.type === "tag";
const tag = (e: Element) => e.name.replace(/^akn:/, "");

export function uriFromHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const m = href.match(/caselaw\.nationalarchives\.gov\.uk\/(?:id\/)?([^?#]+?)(?:\/data\.xml)?\/?$/);
  return m ? m[1] : null;
}

export function parseJudgment(xml: string): ParsedCase {
  const doc = parseDocument(xml, { xmlMode: true, decodeEntities: true });
  const all = doc.children;

  const byTag = (name: string, root: ChildNode[] = all) =>
    findOne((e) => tag(e) === name, root, true);
  const attr = (e: Element | null, a: string) => (e ? getAttributeValue(e, a) ?? null : null);

  // ---- metadata --------------------------------------------------------------------------------
  const work = byTag("FRBRWork");
  const expression = byTag("FRBRExpression");
  const name = attr(work ? byTag("FRBRname", [work]) : null, "value") ?? "Untitled judgment";
  const dateEl = work ? findOne((e) => tag(e) === "FRBRdate", [work], true) : null;
  const expressionThis = attr(expression ? byTag("FRBRthis", [expression]) : null, "value");
  const workThis = attr(work ? byTag("FRBRthis", [work]) : null, "value");
  const uri = uriFromHref(expressionThis) ?? uriFromHref(workThis) ?? "";

  const ukCite = byTag("uk:cite");
  const ncnEl = byTag("neutralCitation");
  const ncn = clean(ukCite ? textContent(ukCite) : ncnEl ? textContent(ncnEl) : "") || null;
  const court = clean(byTag("uk:court") ? textContent(byTag("uk:court")!) : "") || null;
  const hashEl = byTag("uk:hash");

  const judges = findAll((e) => tag(e) === "TLCPerson" && (attr(e, "eId") ?? "").startsWith("judge"), all)
    .map((e) => attr(e, "showAs") ?? "")
    .filter(Boolean);
  const parties = unique(
    findAll((e) => tag(e) === "party", all)
      .map((e) => clean(textContent(e)))
      .filter((s) => s.length > 0 && s.length < 200 && !/^[-(]*\s*(and|v|vs|between|-)\s*[-:.)]*$/i.test(s)),
  );

  // ---- body ------------------------------------------------------------------------------------
  const body = byTag("judgmentBody") ?? byTag("body") ?? byTag("mainBody");
  const elements: ParsedElement[] = [];
  const citations: ParsedCitation[] = [];
  let ord = 0;
  let fallbackCounter = 0;
  const usedIds = new Set<string>();

  const uniqueId = (id: string) => {
    let out = id;
    let n = 2;
    while (usedIds.has(out)) out = `${id}_${n++}`;
    usedIds.add(out);
    return out;
  };

  /**
   * Build one element from a DOM node: walk its subtree collecting text runs, turning designated
   * descendants (sub-paragraphs, quotes) into child elements.
   */
  function buildElement(
    node: Element,
    kind: ParsedElement["kind"],
    elementId: string,
    parentId: string | null,
    splitChildren: boolean,
  ): ParsedElement {
    const el: ParsedElement = { elementId, parentId, kind, num: null, ord: ord++, text: "", parts: [] };
    elements.push(el);
    const numEl = node.children.find((c): c is Element => isEl(c) && tag(c) === "num");
    if (numEl) el.num = clean(textContent(numEl)) || null;

    let buf = "";
    let subN = 0;
    let quoteN = 0;
    const flush = () => {
      if (buf.trim()) el.parts.push({ t: buf });
      buf = "";
    };

    const walk = (n: ChildNode) => {
      if (n.type === "text") {
        buf += (n as unknown as { data: string }).data;
        return;
      }
      if (!isEl(n)) return;
      const t = tag(n);
      if (SKIP_TAGS.has(t) && n !== node) return;
      if (t === "ref") collectRef(n, elementId);
      if (t === "br") {
        buf += "\n";
        return;
      }

      if (splitChildren && n !== node) {
        const isQuote = QUOTE_TAGS.has(t) || (t === "block" && attr(n, "name") === "embeddedStructure");
        const isSub = t === "subparagraph" || t === "paragraph";
        if (isQuote || isSub) {
          flush();
          const childId = isQuote
            ? uniqueId(`${elementId}__quote_${++quoteN}`)
            : uniqueId(attr(n, "eId") ?? `${elementId}__sub_${++subN}`);
          // quotes are kept whole; sub-paragraphs may contain further subs/quotes
          const inner = isQuote && t === "block" ? (n.children.find(isEl) ?? n) : n;
          const child = buildElement(inner, isQuote ? "quote_block" : "subparagraph", childId, elementId, !isQuote);
          el.parts.push({ c: child.elementId });
          return;
        }
      }

      const block = BLOCK_TAGS.has(t) || t === "td";
      if (block && buf && !buf.endsWith("\n")) buf += t === "td" ? " \t " : "\n";
      for (const c of n.children) walk(c);
      if (block && buf && !buf.endsWith("\n")) buf += t === "td" ? " \t " : "\n";
    };

    for (const c of node.children) walk(c);
    flush();
    el.parts = el.parts
      .map((p) => ("t" in p ? { t: tidyWhitespace(p.t.replace(/ \t /g, " ")) } : p))
      .filter((p) => !("t" in p) || p.t.length > 0);
    return el;
  }

  function collectRef(n: Element, fromElementId: string | null) {
    const type = attr(n, "uk:type");
    if (type !== "case" && type !== "legislation") return;
    const canonical = attr(n, "uk:canonical");
    const href = attr(n, "href");
    const raw = clean(textContent(n));
    if (type === "case") {
      citations.push({
        fromElementId,
        type,
        toNcn: attr(n, "uk:isNeutral") === "true" ? canonical : null,
        toUri: uriFromHref(href),
        toLegislation: null,
        href: href && href !== "#" ? href : null,
        raw: canonical ?? raw,
      });
    } else {
      citations.push({
        fromElementId,
        type,
        toNcn: null,
        toUri: null,
        toLegislation: raw || canonical,
        href: href ?? null,
        raw: canonical ?? raw,
      });
    }
  }

  /** Walk a container (body / level / decision) creating top-level elements in order. */
  function walkContainer(node: Element) {
    for (const c of node.children) {
      if (!isEl(c)) continue;
      const t = tag(c);
      if (t === "paragraph") {
        buildElement(c, "paragraph", uniqueId(attr(c, "eId") ?? `p_${++fallbackCounter}`), null, true);
      } else if (CONTAINER_TAGS.has(t)) {
        const hasParas = findOne((e) => tag(e) === "paragraph", c.children, true);
        if (hasParas) {
          // heading/num/content of the level itself before recursing
          const headingText = clean(
            c.children
              .filter((k): k is Element => isEl(k) && ["heading", "subheading", "content", "num"].includes(tag(k)))
              .map((k) => textContent(k))
              .join(" "),
          );
          if (headingText) {
            elements.push({
              elementId: uniqueId(attr(c, "eId") ?? `h_${++fallbackCounter}`),
              parentId: null,
              kind: "heading",
              num: null,
              ord: ord++,
              text: headingText,
              parts: [{ t: headingText }],
            });
          }
          walkContainer(c);
        } else {
          const e = buildElement(c, "heading", uniqueId(attr(c, "eId") ?? `h_${++fallbackCounter}`), null, false);
          // A long "level" without paragraph markup is body text, not a heading.
          if (e.parts.map((p) => ("t" in p ? p.t : "")).join(" ").length > 200) e.kind = "block";
        }
      } else if (!SKIP_TAGS.has(t)) {
        buildElement(c, "block", uniqueId(`blk_${++fallbackCounter}`), null, true);
      }
    }
  }

  if (body) walkContainer(body);

  // compute full text (own text + descendants) bottom-up
  const byId = new Map(elements.map((e) => [e.elementId, e]));
  const fullText = (e: ParsedElement): string => {
    if (e.text) return e.text;
    e.text = tidyWhitespace(
      e.parts.map((p) => ("t" in p ? p.t : fullText(byId.get(p.c)!))).join("\n"),
    );
    return e.text;
  };
  elements.forEach(fullText);

  const kept = elements.filter((e) => e.text.length > 0 || e.parts.some((p) => "c" in p));
  kept.sort((a, b) => a.ord - b.ord);

  const headerText = clean(byTag("header") ? textContent(byTag("header")!) : "");
  return {
    uri,
    ncn,
    name: clean(name),
    court,
    date: attr(dateEl, "date"),
    judges: unique(judges),
    parties,
    anonymised: detectAnonymised(clean(name), court, headerText),
    contentHash: hashEl ? clean(textContent(hashEl)) : null,
    elements: kept,
    citations,
  };
}

const ANON_NAME = [
  /\(a child(ren)?\)/i,
  /\bre\s*:?\s*[A-Z](\s|,|\)|$)/,
  /\b[A-Z]{1,3}\b(\s*(&|and)\s*(anor|ors|another|others))?\s+v\.?\s+[A-Z]{1,3}\b/,
  /\bv\.?\s+[A-Z]{1,3}(\s|$|\()/,
  /\b(care|adoption|placement|wardship|surrogacy) (proceedings|order)\b/i,
];
const ANON_COURTS = /^(EWFC|EWCOP|EWHC-Family)|UKUT-IAC|UKFTT-GRC/i;
const ANON_HEADER = /(reporting restrictions?|anonymity (order|of)|must not be identified|may not be identified|shall not be identified)/i;

export function detectAnonymised(name: string, court: string | null, headerText: string): boolean {
  if (ANON_NAME.some((r) => r.test(name))) return true;
  if (court && ANON_COURTS.test(court)) return true;
  return ANON_HEADER.test(headerText);
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
