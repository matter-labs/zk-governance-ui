import { ChainContext, GovernanceContext } from "@/components/governance-context";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// A veto whose L2 proposal cannot be checked (an unknown governor, or no such proposal) is never
// offered for signing: executed, it would still use the Guardians' nonce. Odd signed link values
// are said before anyone signs, and the title is the proposal's, as the governor list shows it.

const page = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("@remix-run/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@remix-run/react")>()),
  useLoaderData: () => page.data,
  useRevalidator: () => ({ revalidate: vi.fn(), state: "idle" }),
  useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn() }),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useSendTransaction: () => ({ sendTransaction: vi.fn(), isPending: false }),
  useSignTypedData: () => ({ signTypedData: vi.fn(), isPending: false }),
  useConnect: () => ({ connectors: [{ id: "walletConnect" }], connect: vi.fn(), isPending: false }),
}));
vi.mock("@rainbow-me/rainbowkit", () => ({ ConnectButton: { Custom: () => null } }));
vi.mock("@/.server/flows/l2-veto", () => ({ loadL2Veto: vi.fn() }));
vi.mock("@/.server/flows/common", () => ({ freshAfter: vi.fn() }));

const { default: Veto } = await import("@/routes/app/l2-cancellations/$id/_route");

const GOVERNOR = "0x76705327e682F2d96943280D99464Ab61219e34f";
const REFUND = "0x4000000000000000000000000000000000000004";
const ID = "123456789";
const CHAIN = {
  chainId: 1,
  label: "Ethereum Mainnet",
  isDevNode: false,
  explorerUrl: "https://etherscan.io",
  l2ExplorerUrl: null,
};
const governance = {
  network: { chainId: 1, tallyUrl: null, explorerUrl: "https://etherscan.io", l2ExplorerUrl: null },
  latestBlock: { number: "21000000", timestamp: "1790000000" },
  guardians: { address: REFUND, nonce: "1", members: [] },
  securityCouncil: { members: [] },
  emergencyUpgradeBoard: { zkFoundation: REFUND },
};
const params = {
  l2ProposalId: ID,
  l2GovernorAddress: GOVERNOR,
  l2GasLimit: "30000000",
  l2GasPerPubdataByteLimit: "800",
  refundRecipient: REFUND,
  txMintValue: "20000000000000000",
  nonce: "1",
};
const set = {
  signerGroup: "guardians",
  typedData: { domain: { chainId: 1 }, message: {} },
  hashes: { digest: `0x${"c".repeat(64)}` },
  threshold: 5,
  members: [],
  valid: [],
  thresholdCheck: { status: "below", valid: 0, threshold: 5 },
  safeApiError: null,
};
const proposal = {
  description: "‮# [ZIP-9] Title\nbody",
  governorName: "Protocol governor",
  state: "Active",
  voteStart: "1789000000",
  voteEnd: "1791000000",
  idMatchesLocal: true,
  idMatchesContract: true,
  proposer: REFUND,
  createdTx: `0x${"1".repeat(64)}`,
  targets: [],
  values: [],
  calldatas: [],
};

function show(detail: Record<string, unknown>) {
  const d = {
    params,
    set,
    state: { status: "open" },
    execution: null,
    l2Proposal: proposal,
    l2Error: null,
    eraHead: null,
    governorKnown: true,
    governance,
    ...detail,
  };
  // The page's Await with the detail already in.
  page.data = {
    veto: d.params,
    eraKey: "era",
    fresh: null,
    detail: Object.assign(Promise.resolve(d), { _tracked: true, _data: d }),
  };
  return renderToString(
    <ChainContext.Provider value={CHAIN}>
      <GovernanceContext.Provider value={{ ok: true, governance } as never}>
        <Veto />
      </GovernanceContext.Provider>
    </ChainContext.Provider>
  ).replaceAll("<!-- -->", "");
}

describe("a Guardian veto's page", () => {
  it("offers a checked veto for signing, under the proposal's own title stripped of hidden characters", () => {
    const html = show({});
    // The title: no direction override (the full description below is shown as written).
    expect(html).toMatch(/<h1[^>]*>\[ZIP-9\] Title<\/h1>/);
    expect(html).toContain('data-testid="your-signature"');
    expect(html).not.toContain("veto-not-offered");
  });

  it("never offers a veto of an unknown governor, nor of a proposal the governor does not have", () => {
    for (const html of [show({ governorKnown: false }), show({ l2Proposal: null })]) {
      expect(html).toContain('data-testid="veto-not-offered"');
      expect(html).toContain('data-testid="veto-unverifiable"');
      expect(html).not.toContain('data-testid="your-signature"');
    }
  });

  it("says odd signed values before anyone signs", () => {
    const html = show({ params: { ...params, l2GasPerPubdataByteLimit: "1" } });
    expect(html).toContain('data-testid="veto-caution"');
    expect(html).toContain("ZKsync Era accepts only 800");
  });
});
