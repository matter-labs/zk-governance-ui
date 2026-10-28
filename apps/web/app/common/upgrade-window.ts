// The upgrades list's time filter for completed upgrades: the last 45 days (the default), the last
// 90, or everything since the handler was deployed (?history=90 / all). An upgrade in progress is
// listed whatever its age ("Ready" lasts until someone executes it).
export const UPGRADE_WINDOWS = ["45", "90", "all"] as const;
export type UpgradeWindow = (typeof UPGRADE_WINDOWS)[number];

export const UPGRADE_WINDOW_LABELS: Record<UpgradeWindow, string> = {
  "45": "Last 45 days",
  "90": "Last 90 days",
  all: "All time",
};

export function upgradeWindow(raw: string | null | undefined): UpgradeWindow {
  return raw === "90" || raw === "all" ? raw : "45";
}
