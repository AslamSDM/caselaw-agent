"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Core, ElementDefinition } from "cytoscape";
import type { CitationGraph, GraphNode } from "@/lib/graph";

/** court level → legend label (colours come from CSS variables so both themes work) */
const LEVELS: { level: number; label: string; varName: string }[] = [
  { level: 1, label: "Supreme Court / HL", varName: "--g-l1" },
  { level: 2, label: "Court of Appeal", varName: "--g-l2" },
  { level: 3, label: "High Court / Upper Tribunal", varName: "--g-l3" },
  { level: 4, label: "First instance", varName: "--g-l4" },
  { level: 0, label: "Legislation", varName: "--g-leg" },
];

const ROLE_TEXT: Record<GraphNode["role"], string> = {
  center: "This judgment",
  cites: "Cited by this judgment",
  cited_by: "Cites this judgment",
  both: "Cites and is cited by this judgment",
  result: "Search result",
  shared: "Authority shared by several results",
  legislation: "Legislation cited",
};

export function GraphView({ graph, mode }: { graph: CitationGraph; mode: "case" | "search" }) {
  const box = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(graph.nodes.find((n) => n.role === "center") ?? null);
  const [showLeg, setShowLeg] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cytoscape = (await import("cytoscape")).default;
      if (cancelled || !box.current) return;
      const css = getComputedStyle(document.documentElement);
      const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
      const color = (n: GraphNode) =>
        n.role === "legislation"
          ? v("--g-leg", "#8a8a8a")
          : v(`--g-l${Math.min(4, Math.max(1, n.level))}`, "#999");
      const maxCited = Math.max(1, ...graph.nodes.map((n) => n.citedBy));
      const size = (n: GraphNode) =>
        n.role === "center" ? 46 : n.role === "legislation" ? 18 : 16 + 30 * Math.sqrt(n.citedBy / maxCited);

      const elements: ElementDefinition[] = [
        ...graph.nodes.map((n) => ({
          data: { id: n.id, label: n.label, color: color(n), size: size(n), role: n.role, stored: n.stored ? 1 : 0 },
        })),
        ...graph.edges.map((e, i) => ({ data: { id: `e${i}`, source: e.source, target: e.target, w: Math.min(6, 1 + Math.log2(e.weight)) } })),
      ];
      const fg = v("--foreground", "#222");
      const muted = v("--muted", "#888");
      const accent = v("--accent", "#7a3e12");

      cyRef.current?.destroy();
      const cy = cytoscape({
        container: box.current,
        elements,
        minZoom: 0.2,
        maxZoom: 3,
        style: [
          {
            selector: "node",
            style: {
              "background-color": "data(color)",
              width: "data(size)",
              height: "data(size)",
              label: "data(label)",
              "font-size": 9,
              color: fg,
              "text-valign": "bottom",
              "text-margin-y": 3,
              "text-wrap": "ellipsis",
              "text-max-width": "120px",
              "border-width": 0,
            },
          },
          { selector: "node[stored = 0]", style: { "background-opacity": 0.55 } },
          { selector: 'node[role = "legislation"]', style: { shape: "diamond" } },
          { selector: 'node[role = "center"], node[role = "result"]', style: { "border-width": 3, "border-color": accent, "font-weight": "bold" } },
          {
            selector: "edge",
            style: {
              width: "data(w)",
              "line-color": muted,
              "target-arrow-color": muted,
              "target-arrow-shape": "triangle",
              "arrow-scale": 0.7,
              "curve-style": "bezier",
              opacity: 0.45,
            },
          },
          { selector: "node:selected", style: { "border-width": 4, "border-color": accent } },
          { selector: ".faded", style: { opacity: 0.12 } },
        ],
        layout:
          mode === "case"
            ? {
                name: "concentric",
                concentric: (n) => ({ center: 4, both: 3, cited_by: 2, cites: 2, legislation: 1 })[n.data("role") as string] ?? 1,
                levelWidth: () => 1,
                minNodeSpacing: 18,
                animate: false,
              }
            : { name: "cose", animate: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 90, padding: 30 },
      });
      cy.on("tap", "node", (evt) => {
        const id = evt.target.id();
        setSelected(graph.nodes.find((n) => n.id === id) ?? null);
        cy.elements().removeClass("faded");
        cy.elements().not(evt.target.closedNeighborhood()).addClass("faded");
      });
      cy.on("tap", (evt) => {
        if (evt.target === cy) cy.elements().removeClass("faded");
      });
      cyRef.current = cy;
    })();
    return () => {
      cancelled = true;
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, [graph, mode]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes('[role = "legislation"]').style("display", showLeg ? "element" : "none");
  }, [showLeg]);

  const hasLeg = graph.nodes.some((n) => n.role === "legislation");

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0">
        <div ref={box} className="h-[70vh] min-h-[420px] w-full rounded-lg border border-border bg-surface" aria-label="Citation graph" />
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          {LEVELS.filter((l) => l.level !== 0 || hasLeg).map((l) => (
            <span key={l.level} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: `var(${l.varName})` }} />
              {l.label}
            </span>
          ))}
          <span>size = how many stored judgments cite it · faded = not stored locally</span>
          {hasLeg && (
            <label className="ml-auto inline-flex items-center gap-1.5">
              <input id="graph-show-legislation" type="checkbox" checked={showLeg} onChange={(e) => setShowLeg(e.target.checked)} />
              legislation
            </label>
          )}
        </div>
      </div>

      <aside className="space-y-3 text-sm">
        {selected ? (
          <div className="rounded-lg border border-border bg-surface p-4">
            <p className="text-xs uppercase tracking-wide text-muted">{ROLE_TEXT[selected.role]}</p>
            <h2 className="mt-1 font-semibold leading-snug">{selected.name ?? selected.label}</h2>
            <p className="mt-1 text-xs text-muted">
              {[selected.ncn, selected.court !== "Legislation" ? selected.court : null, selected.year].filter(Boolean).join(" · ")}
            </p>
            {selected.role !== "legislation" && (
              <p className="mt-2 text-xs text-muted">
                Cited by {selected.citedBy} stored judgment{selected.citedBy === 1 ? "" : "s"}
                {!selected.onTna
                  ? " · not published on Find Case Law"
                  : !selected.stored && " · not stored yet (opening it fetches it from Find Case Law)"}
              </p>
            )}
            {selected.uri && selected.onTna && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href={`/case/${selected.uri}`} className="rounded border border-border px-2.5 py-1 hover:border-accent">
                  Open judgment
                </Link>
                {selected.role !== "center" && (
                  <Link href={`/graph?case=${encodeURIComponent(selected.uri)}`} className="rounded border border-border px-2.5 py-1 hover:border-accent">
                    Graph from here
                  </Link>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="text-muted">Click a node to see the judgment. Click empty space to clear.</p>
        )}
        <MostCited graph={graph} onPick={setSelected} />
      </aside>
    </div>
  );
}

function MostCited({ graph, onPick }: { graph: CitationGraph; onPick: (n: GraphNode) => void }) {
  const top = graph.nodes
    .filter((n) => n.role !== "center" && n.role !== "legislation" && n.role !== "result")
    .sort((a, b) => b.citedBy - a.citedBy || (a.level - b.level))
    .slice(0, 8);
  if (!top.length) return null;
  return (
    <div className="rounded-lg border border-border p-4">
      <h3 className="mb-2 font-semibold">Most-cited here</h3>
      <ol className="space-y-1.5">
        {top.map((n) => (
          <li key={n.id}>
            <button type="button" onClick={() => onPick(n)} className="text-left hover:underline">
              {n.name ?? n.label}
            </button>
            <span className="ml-1 text-xs text-muted">· {n.citedBy}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
