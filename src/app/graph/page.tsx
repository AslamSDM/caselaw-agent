import Link from "next/link";
import { notFound } from "next/navigation";
import { ensureCase } from "@/lib/cases/store";
import { caseGraph, searchGraph } from "@/lib/graph";
import { GraphView } from "@/components/graph-view";

export default async function GraphPage({ searchParams }: PageProps<"/graph">) {
  const sp = await searchParams;
  const caseUri = typeof sp.case === "string" ? sp.case.replace(/^\/+|\/+$/g, "") : null;
  const searchId = typeof sp.search === "string" ? Number(sp.search) : NaN;

  let graph = null;
  let mode: "case" | "search" = "case";
  if (caseUri) {
    // make sure the judgment (and so its citations) is stored
    if (!(await ensureCase(caseUri))) notFound();
    graph = await caseGraph(caseUri);
  } else if (Number.isFinite(searchId)) {
    mode = "search";
    graph = await searchGraph(searchId);
  }
  if (!graph) notFound();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <header className="mb-4">
        <p className="text-xs uppercase tracking-wide text-muted">{mode === "case" ? "Citation graph" : "Citation graph of search results"}</p>
        <h1 className="mt-1 text-2xl font-semibold leading-tight">
          {mode === "case" && caseUri ? <Link href={`/case/${caseUri}`} className="hover:underline">{graph.title}</Link> : `“${graph.title}”`}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {graph.subtitle}
          {graph.omitted > 0 && ` · ${graph.omitted} less-cited cases left out`}
        </p>
      </header>
      {graph.nodes.length ? (
        <GraphView graph={graph} mode={mode} />
      ) : (
        <p className="text-muted">Nothing to draw yet.</p>
      )}
    </div>
  );
}
