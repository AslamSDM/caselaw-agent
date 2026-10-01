import { SearchClient, type DateInput } from "@/components/search-client";
import { isAreaId } from "@/lib/areas";

export default async function Home({ searchParams }: PageProps<"/">) {
  const { q, areas, from, to, nodates } = await searchParams;
  const str = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);
  const areaList = typeof areas === "string" ? areas.split(",").filter(isAreaId) : [];
  const dates: DateInput = nodates ? null : str(from) || str(to) ? { from: str(from), to: str(to) } : undefined;
  return <SearchClient initialQuery={str(q)} initialAreas={areaList} initialDates={dates} />;
}
