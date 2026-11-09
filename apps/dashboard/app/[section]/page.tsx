import { notFound } from "next/navigation";
import { dashboardSections, isDashboardSection } from "../sections";

export const dynamicParams = false;

export function generateStaticParams() {
  return dashboardSections
    .filter((section) => section !== "overview")
    .map((section) => ({ section }));
}

export default async function DashboardSectionRoute({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!isDashboardSection(section) || section === "overview") notFound();
  return null;
}
