export const dashboardSections = [
  "overview",
  "recovery",
  "security",
  "escrow",
  "sentinel",
  "explorer",
  "analytics",
  "token-economics",
  "methodology",
  "developers",
  "about",
] as const;

export type DashboardSection = (typeof dashboardSections)[number];

export function isDashboardSection(value: string): value is DashboardSection {
  return (dashboardSections as readonly string[]).includes(value);
}

export function sectionHref(section: DashboardSection): string {
  return section === "overview" ? "/near-phoenix/" : `/near-phoenix/${section}/`;
}
