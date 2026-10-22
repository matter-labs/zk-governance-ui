import { upgradeProposalId } from "@/common/proposal";
import { isSimulatorFile, simulatorCalls } from "@/common/simulator";
import { ChainContext, GovernanceContext } from "@/components/governance-context";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import "@testing-library/jest-dom";
import { type Hex, getAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

// A transaction-simulator file (matter-labs/transaction-simulator) where a payload is pasted: the
// calls the ProtocolUpgradeHandler sends on this L1, in order, values from ETH to wei. Everything
// else in it is other wallets' to send.

const page = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("@remix-run/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@remix-run/react")>()),
  useLoaderData: () => page.data,
  useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn() }),
  useNavigate: () => vi.fn(),
  useRevalidator: () => ({ revalidate: vi.fn(), state: "idle" }),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
// The pages' server modules (their loaders and actions are not run here).
vi.mock("@/.server/flows/emergency-draft", () => ({ checkDraftCalls: vi.fn() }));
vi.mock("@/.server/flows/emergency", () => ({ loadEmergencyUpgrade: vi.fn() }));
vi.mock("@/.server/flows/common", () => ({ freshAfter: vi.fn() }));
vi.mock("@/.server/governance", () => ({ governance: vi.fn() }));
vi.mock("@/.server/signatures", () => ({ simulate: vi.fn() }));

const { default: NewEmergency } = await import("@/routes/app/emergency/new/_route");
const { default: EmergencyPage } = await import("@/routes/app/emergency/$id/_route");

const HANDLER = "0xE30Dca3047B37dc7d88849dE4A4Dc07937ad5Ab3";
const BOARD = "0xECE8e30bFc92c2A8e11e6cb2e17B70868572E3f6";
const CHAIN_ADMIN = "0x4e4943346848c4867f81dfb37c4ca9c5715a7828";
const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const SALT = `0x${"12".repeat(32)}` as Hex;

const FILE = [
  { network: "mainnet", from: HANDLER, to: A, data: "0x1234", value: "0.0002", tag: "stage1" },
  { network: "mainnet", from: CHAIN_ADMIN, to: B, data: "0x99", value: "0", tag: "bundle_4" },
  { network: "zksync", from: HANDLER, to: B, data: "0x77", value: "0", tag: "stage1" },
  { network: "mainnet", from: HANDLER, to: B, data: "0x5678", value: "0", tag: "stage1" },
  { network: "mainnet", from: HANDLER, to: A, data: "0x", value: "0", testOnly: true },
];
const CALLS = [
  { target: getAddress(A), value: "200000000000000", data: "0x1234" as Hex },
  { target: getAddress(B), value: "0", data: "0x5678" as Hex },
];
const ID = upgradeProposalId({
  calls: CALLS,
  executor: BOARD,
  salt: SALT,
});

const status = {
  ok: true,
  governance: {
    network: { name: "mainnet", label: "Ethereum Mainnet", chainId: 1 },
    upgradeHandler: HANDLER,
    emergencyUpgradeBoard: { address: BOARD },
  },
};
const chain = {
  chainId: 1,
  label: "Ethereum Mainnet",
  isDevNode: false,
  explorerUrl: "https://etherscan.io",
  l2ExplorerUrl: null,
};

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("a transaction-simulator file", () => {
  it("gives the calls the handler sends on this L1, in order, values in wei", () => {
    expect(isSimulatorFile(FILE)).toBe(true);
    const taken = simulatorCalls(FILE, { network: "mainnet", handler: HANDLER });
    expect(taken).toEqual({
      ok: true,
      calls: CALLS,
      summary:
        "2 calls the ProtocolUpgradeHandler sends (stage1 2); 3 other transactions left out (other senders or networks, or test-only).",
    });
  });

  it("is told apart from a payload, and says why it gives nothing", () => {
    expect(isSimulatorFile({ salt: SALT, calls: [] })).toBe(false);
    expect(isSimulatorFile([])).toBe(false);
    expect(simulatorCalls(FILE, { network: "sepolia", handler: HANDLER })).toEqual({
      ok: false,
      error: `No transaction in this transaction-simulator file is sent by the ProtocolUpgradeHandler ${HANDLER} on sepolia, and those are a governance upgrade's calls.`,
    });
    const bad = [{ network: "mainnet", from: HANDLER, to: A, data: "0x", value: "a lot" }];
    expect(simulatorCalls(bad, { network: "mainnet", handler: HANDLER })).toEqual({
      ok: false,
      error: 'Transaction 1: "value" a lot is not an amount in ETH.',
    });
  });

  it("pasted in the builder, fills its calls and shows the payload they make", async () => {
    render(
      <GovernanceContext.Provider value={status as never}>
        <ChainContext.Provider value={chain}>
          <NewEmergency />
        </ChainContext.Provider>
      </GovernanceContext.Provider>
    );
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    fireEvent.change(screen.getByTestId("payload-json"), {
      target: { value: JSON.stringify(FILE) },
    });
    expect(screen.getByTestId("from-simulator")).toHaveTextContent(
      "From a transaction-simulator file: 2 calls the ProtocolUpgradeHandler sends (stage1 2); 3 other transactions left out"
    );
    expect(screen.queryByTestId("payload-json-error")).toBeNull();
    // The text is now the payload: the calls in wei, with the salt set here (the file has none).
    const shown = JSON.parse((screen.getByTestId("payload-json") as HTMLTextAreaElement).value);
    expect(shown).toEqual({ salt: `0x${"0".repeat(64)}`, calls: CALLS });
    // The form has them, and the id is the one they hash to.
    fireEvent.click(screen.getByRole("button", { name: "Form" }));
    expect(screen.getAllByPlaceholderText("Target address")).toHaveLength(2);
    const id = upgradeProposalId({
      calls: CALLS,
      executor: BOARD,
      salt: `0x${"0".repeat(64)}`,
    });
    expect(document.body).toHaveTextContent(id);
  });

  it("loaded on an upgrade's page, is checked against the id once the proposer's salt is given", async () => {
    const pending = () => new Promise<never>(() => {});
    page.data = {
      id: ID,
      detail: Promise.resolve({ id: ID, state: 2, governance: status.governance }),
      executed: pending(),
      executedCheck: pending(),
      executedHistorical: pending(),
      verified: pending(),
      verifiedFresh: pending(),
    };
    render(
      <ChainContext.Provider value={chain}>
        <EmergencyPage />
      </ChainContext.Provider>
    );
    const box = await screen.findByLabelText(
      "Paste the payload JSON or a transaction-simulator file, or drop either here"
    );
    fireEvent.change(box, { target: { value: JSON.stringify(FILE) } });
    fireEvent.click(screen.getByTestId("check-payload"));
    expect(screen.getByTestId("simulator-salt")).toHaveTextContent(
      "2 calls the ProtocolUpgradeHandler sends (stage1 2)"
    );
    const check = screen.getByTestId("check-simulator");
    expect(check).toBeDisabled();

    // Another salt: the calls do not hash to the signed id.
    fireEvent.change(screen.getByLabelText("Salt"), { target: { value: `0x${"00".repeat(32)}` } });
    fireEvent.click(check);
    expect(screen.getByTestId("payload-error")).toHaveTextContent("not to the signed id");

    // The proposer's: they do, and the page shows them as the payload.
    fireEvent.change(screen.getByLabelText("Salt"), { target: { value: SALT } });
    await act(async () => fireEvent.click(screen.getByTestId("check-simulator")));
    expect(screen.getByTestId("payload-ok")).toHaveTextContent("The payload hashes to this id");
  });
});
