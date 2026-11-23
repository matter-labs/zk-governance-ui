import { StatusSourceContext } from "@/components/governance-context";
import { act, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// Pages whose first answer may come from what the app holds (the history the last run saved,
// Safe copies older than 60 s): the home page's counts and the freeze requests. Each says where it
// came from while the fresh answer is read, the fresh answer replaces it (without the label), and
// a fresh answer that fails leaves the label saying so.

const page = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("@remix-run/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@remix-run/react")>()),
  useLoaderData: () => page.data,
  useActionData: () => undefined,
  useNavigation: () => ({ state: "idle", location: undefined }),
  useNavigate: () => vi.fn(),
  Form: ({ children }: { children: ReactNode }) => <form>{children}</form>,
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
// The pages' server modules (their loaders are not run here).
vi.mock("@/.server/flows/common", () => ({ freshAfter: vi.fn() }));
vi.mock("@/.server/flows/standard", () => ({ listStandardUpgrades: vi.fn() }));
vi.mock("@/.server/flows/emergency", () => ({ loadEmergencyList: vi.fn() }));
vi.mock("@/.server/flows/freeze", () => ({ loadFreezeList: vi.fn() }));
vi.mock("@/.server/rpc", () => ({ network: vi.fn(), l1: {} }));

const { default: Home } = await import("@/routes/_index/_route");
const { default: Freeze } = await import("@/routes/app/freeze/_index/_route");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const pending = () => new Promise<never>(() => {});
const OLD = "2026-10-01T10:00:00.000Z";
const NOW = new Date().toISOString();

/** A page under a root status still being read (whatever needs it shows its fallback). */
function show(Page: () => ReactNode, data: Record<string, unknown>) {
  page.data = data;
  return render(
    <StatusSourceContext.Provider value={pending()}>
      <Page />
    </StatusSourceContext.Provider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the home page's counts", () => {
  const home = (counts: Record<string, unknown>) => ({
    upgrades: pending(),
    upgradesFresh: pending(),
    emergency: pending(),
    emergencyFresh: pending(),
    freeze: pending(),
    freezeFresh: pending(),
    ...counts,
  });

  it("from the last run's history and old Safe copies are labelled until the fresh count replaces them", async () => {
    const fresh = deferred<unknown>();
    show(
      Home,
      home({
        emergency: Promise.resolve({
          pending: 2,
          executed: 1,
          incomplete: false,
          source: { lastRun: true, safeFetchedAt: OLD },
        }),
        emergencyFresh: fresh.promise,
      })
    );
    const row = screen.getByTestId("flow-emergency");
    const note = await within(row).findByTestId("summary-note");
    expect(note).toHaveTextContent(/History from last run · Safe copies from .+ · re-verifying/);
    expect(row).toHaveTextContent("2 pending");

    await act(async () =>
      fresh.resolve({ pending: 1, executed: 1, incomplete: false, source: null })
    );
    expect(within(row).queryByTestId("summary-note")).toBeNull();
    expect(row).toHaveTextContent("1 pending");
  });

  it("stays labelled, saying so, when the fresh count could not be read", async () => {
    const fresh = deferred<unknown>();
    show(
      Home,
      home({
        freeze: Promise.resolve({
          open: 1,
          incomplete: false,
          source: { lastRun: false, safeFetchedAt: OLD },
        }),
        freezeFresh: fresh.promise,
      })
    );
    const row = screen.getByTestId("flow-freeze");
    await within(row).findByTestId("summary-note");
    await act(async () => fresh.reject(new Error("Safe rate limited")));
    expect(within(row).getByTestId("summary-note")).toHaveTextContent(
      /Safe copies from .+ · checking again did not complete/
    );
    expect(row).toHaveTextContent("1 open for signatures");
  });

  it("from fresh sources carry no label", async () => {
    show(
      Home,
      home({
        upgrades: Promise.resolve({ open: 1, total: 3, source: null }),
        freeze: Promise.resolve({ open: 0, incomplete: false, source: null }),
      })
    );
    const upgrades = screen.getByTestId("flow-upgrades");
    expect(await within(upgrades).findByText("in progress", { exact: false })).toBeInTheDocument();
    expect(upgrades).toHaveTextContent("1 in progress");
    expect(screen.getByTestId("flow-freeze")).toHaveTextContent("0 open for signatures");
    expect(screen.queryByTestId("summary-note")).toBeNull();
  });
});

describe("the freeze request list", () => {
  const request = (nonce: string) => ({
    action: "SoftFreeze",
    nonce,
    validUntil: "1790000000",
    digest: `0x${nonce.padStart(64, "0")}`,
    reportedSigners: 2,
    firstSeen: OLD,
    state: { status: "open" },
  });

  it("from old Safe copies is labelled until the fresh list replaces it", async () => {
    const fresh = deferred<unknown>();
    show(Freeze, {
      list: Promise.resolve({
        requests: [request("0")],
        errors: [],
        anomalies: 0,
        safeFetchedAt: OLD,
        stale: true,
      }),
      freshList: fresh.promise,
    });
    expect(await screen.findByTestId("set-stale")).toHaveTextContent(/Safe copies from/);
    expect(screen.getAllByTestId("freeze-row")).toHaveLength(1);
    await act(async () =>
      fresh.resolve({
        requests: [request("0"), request("1")],
        errors: [],
        anomalies: 0,
        safeFetchedAt: NOW,
        stale: false,
      })
    );
    expect(screen.queryByTestId("set-stale")).toBeNull();
    expect(screen.getAllByTestId("freeze-row")).toHaveLength(2);
  });
});
