import { parseDocument } from "htmlparser2";
import type { Element } from "domhandler";
import { findAll, findOne, getAttributeValue, textContent } from "domutils";
import { uriFromHref } from "./parser";

export interface AtomEntry {
  uri: string;
  name: string;
  ncn: string | null;
  court: string | null;
  date: string | null;
  contentHash: string | null;
}

export interface AtomPage {
  entries: AtomEntry[];
  /** estimated total hits from the rel="last" page link */
  estimatedTotal: number;
}

export function parseAtom(xml: string, perPage: number): AtomPage {
  const doc = parseDocument(xml, { xmlMode: true, decodeEntities: true });
  const entries = findAll((e) => e.name === "entry", doc.children).map((entry): AtomEntry => {
    const one = (name: string) => findOne((e) => e.name === name, entry.children, true);
    const txt = (e: Element | null) => (e ? textContent(e).trim() : null);
    const ncnEl = findOne(
      (e) => e.name === "tna:identifier" && getAttributeValue(e, "type") === "ukncn",
      entry.children,
      true,
    );
    const dataLink = findOne(
      (e) => e.name === "link" && getAttributeValue(e, "type") === "application/akn+xml",
      entry.children,
      true,
    );
    const uri =
      (ncnEl && getAttributeValue(ncnEl, "slug")) ||
      uriFromHref(dataLink ? getAttributeValue(dataLink, "href") : null) ||
      txt(one("tna:uri")) ||
      "";
    const author = one("author");
    return {
      uri,
      name: txt(one("title")) ?? "",
      ncn: txt(ncnEl),
      court: author ? txt(findOne((e) => e.name === "name", author.children, true)) : null,
      date: txt(one("published"))?.slice(0, 10) ?? null,
      contentHash: txt(one("tna:contenthash")),
    };
  });

  const last = findOne(
    (e) => e.name === "link" && getAttributeValue(e, "rel") === "last",
    doc.children,
    true,
  );
  const lastPage = Number(last && getAttributeValue(last, "href")?.match(/[?&]page=(\d+)/)?.[1]);
  const estimatedTotal = lastPage > 1 ? (lastPage - 1) * perPage + perPage / 2 : entries.length;
  return { entries: entries.filter((e) => e.uri), estimatedTotal: Math.round(estimatedTotal) };
}
