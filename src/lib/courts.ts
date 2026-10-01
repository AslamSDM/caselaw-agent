/** Court label + precedent weight for display. Lower level = more binding. */
export function courtInfo(court: string | null | undefined): { label: string; level: number; tier: string } {
  const c = (court ?? "").toUpperCase();
  if (c.startsWith("UKSC")) return { label: "UK Supreme Court", level: 1, tier: "Supreme Court" };
  if (c.startsWith("UKHL")) return { label: "House of Lords", level: 1, tier: "Supreme Court" };
  if (c.startsWith("UKPC")) return { label: "Privy Council", level: 1, tier: "Persuasive" };
  if (c.startsWith("EWCA")) return { label: c.includes("CRIM") ? "Court of Appeal (Criminal)" : "Court of Appeal (Civil)", level: 2, tier: "Appellate" };
  if (c.startsWith("EWHC")) {
    const div = c.split("-")[1];
    return { label: `High Court${div ? ` (${div.charAt(0) + div.slice(1).toLowerCase()})` : ""}`, level: 3, tier: "High Court" };
  }
  if (c.startsWith("UKUT")) return { label: "Upper Tribunal", level: 3, tier: "Upper Tribunal" };
  if (c.startsWith("EAT") || c.startsWith("UKEAT")) return { label: "Employment Appeal Tribunal", level: 3, tier: "Upper Tribunal" };
  if (c.startsWith("EWFC")) return { label: "Family Court", level: 4, tier: "First instance" };
  if (c.startsWith("EWCOP")) return { label: "Court of Protection", level: 4, tier: "First instance" };
  if (c.startsWith("UKFTT")) return { label: "First-tier Tribunal", level: 4, tier: "First instance" };
  return { label: court || "Unknown court", level: 5, tier: "Other" };
}
