import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The upgrades page: a short header, nothing in progress said in one line, the upgrades in progress
// in the order they started, and the completed upgrades' time range in a dropdown.

const page = vi.hoisted(() => ({
  range: "45",
  navigate: vi.fn(),
  // The list as the server gives it (newest first); null: one completed upgrade.
  upgrades: null as unknown[] | null,
}));
const upgrade = (id: string, blockNumber: string, state: number) => ({
  id,
  proposal: { calls: [], executor: `0x${"00".repeat(20)}`, salt: `0x${"00".repeat(32)}` },
  idMatches: true,
  blockNumber,
  txHash: `0x${"ab".repeat(32)}`,
  state,
  stateLabel: state === 6 ? "Done" : "Waiting for approval",
  createdAt: 1_700_000_000,
  approvedBySecurityCouncil: state === 6,
  approvedByGuardians: false,
  legalVetoExtended: false,
});
vi.mock("@/.server/flows/standard", () => ({ listStandardUpgrades: vi.fn() }));
vi.mock("@remix-run/react", async (original) => ({
  ...(await original<typeof import("@remix-run/react")>()),
  useLoaderData: () => ({
    list: Promise.resolve({
      upgrades: page.upgrades ?? [upgrade(`0x${"1".padStart(64, "0")}`, "21800000", 6)],
      fromBlock: "21788382",
      allHistory: false,
    }),
    freshList: Promise.resolve(null),
    range: page.range,
  }),
  useNavigation: () => ({ state: "idle" }),
  useNavigate: () => page.navigate,
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
const { default: Proposals } = await import("@/routes/app/proposals/_index/_route");

beforeEach(() => {
  page.range = "45";
  page.navigate.mockReset();
  page.upgrades = null;
});

describe("the upgrades page", () => {
  it("keeps the header to a title, one line and Start upgrade", async () => {
    render(<Proposals />);
    expect(screen.getByRole("link", { name: "Start upgrade" })).toBeInTheDocument();
    expect(
      screen.getByText("Upgrades voted on ZKsync Era and started on L1, and where each stands.")
    ).toBeInTheDocument();
    expect(screen.queryByText("How upgrades work")).toBeNull();
  });

  it("says nothing is in progress in one line, and lists completed upgrades under their range", async () => {
    render(<Proposals />);
    expect(await screen.findByTestId("no-active")).toHaveTextContent("No active upgrades");
    expect(screen.queryByTestId("active-upgrades")).toBeNull();
    expect(screen.getByRole("heading", { name: "Completed upgrades" })).toBeInTheDocument();
    expect(screen.getAllByTestId("upgrade-row")).toHaveLength(1);
  });

  it("lists upgrades in progress in the order they started (one L2 proposal's #1, #2, #3), completed ones newest first", async () => {
    // ZIP-18's three L1 proposals, started in order, and two completed upgrades: newest first.
    const zip18 = {
      first: "0xd0b892663947d43cf35585cd69ac4232273ef3815636bafbe619a49f04cd6520",
      second: "0xa22a67fa0ea12868c8e244dba6cdc254fb6d694216422568854f1204db8b0bd8",
      third: "0x2b466fa6f9b958e2d3b34d77c80b2d7e6d35c096b3e4145558be84e965c7a3dd",
    };
    const older = `0x${"2".padStart(64, "0")}`;
    const newer = `0x${"3".padStart(64, "0")}`;
    page.upgrades = [
      upgrade(zip18.third, "26240741", 2),
      upgrade(zip18.second, "26240739", 2),
      upgrade(zip18.first, "26240724", 2),
      upgrade(newer, "26100000", 6),
      upgrade(older, "26000000", 6),
    ];
    render(<Proposals />);
    const prefix = (row: HTMLElement) => row.textContent?.match(/0x[0-9a-f]{8}/)?.[0];
    const active = await screen.findByTestId("active-upgrades");
    expect(within(active).getAllByTestId("upgrade-row").map(prefix)).toEqual([
      zip18.first.slice(0, 10),
      zip18.second.slice(0, 10),
      zip18.third.slice(0, 10),
    ]);
    expect(
      within(screen.getByTestId("finished-upgrades")).getAllByTestId("upgrade-row").map(prefix)
    ).toEqual([newer.slice(0, 10), older.slice(0, 10)]);
  });

  it("switches the range from its dropdown: last 45 days, last 90 days, all time", async () => {
    page.range = "90";
    render(<Proposals />);
    const select = (await screen.findByTestId("upgrade-window")) as HTMLSelectElement;
    expect(select.value).toBe("90");
    expect([...select.options].map((o) => o.text)).toEqual([
      "Last 45 days",
      "Last 90 days",
      "All time",
    ]);
    fireEvent.change(select, { target: { value: "all" } });
    expect(page.navigate).toHaveBeenLastCalledWith("/app/proposals?history=all");
    fireEvent.change(select, { target: { value: "45" } });
    expect(page.navigate).toHaveBeenLastCalledWith("/app/proposals");
  });
});
