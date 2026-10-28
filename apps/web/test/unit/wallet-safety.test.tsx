import { longValidityWarning } from "@/common/freeze";
import { vetoValueWarnings, VETO_DEFAULTS } from "@/common/veto";
import { StatusProblem } from "@/components/app-shell";
import { isSafeWalletPeer } from "@/components/connect-button";
import { ChainContext } from "@/components/governance-context";
import { chainFor, noBrowserRpc } from "@/components/providers/wallet-provider";
import { ExecutionPanel } from "@/components/verification/execution-panel";
import { SignButton } from "@/components/verification/sign-button";
import { rpcHostLabel } from "@/utils/rpc-host";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What keeps a signer's wallet on this page's chain and its transactions off public RPCs, what the
// review says before signing, and what the page says about odd values and its own RPC.

const wallet = vi.hoisted(() => ({
  address: undefined as string | undefined,
  chainId: undefined as number | undefined,
}));
const walletSend = vi.hoisted(() => ({ sendTransaction: vi.fn() }));
const walletSign = vi.hoisted(() => ({ signTypedData: vi.fn() }));

vi.mock("@/components/governance-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/governance-context")>()),
  useStatusIfRead: () => ({
    ok: true,
    governance: {
      securityCouncil: { members: [MEMBER] },
      guardians: { members: [] },
      emergencyUpgradeBoard: { zkFoundation: "0x0000000000000000000000000000000000000009" },
    },
  }),
}));
vi.mock("@remix-run/react", () => ({
  useNavigate: () => vi.fn(),
  useRevalidator: () => ({ revalidate: vi.fn(), state: "idle" }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({
    address: wallet.address,
    isConnected: !!wallet.address,
    chainId: wallet.address ? wallet.chainId : undefined,
  }),
  useSendTransaction: () => ({ sendTransaction: walletSend.sendTransaction, isPending: false }),
  useSignTypedData: () => ({ signTypedData: walletSign.signTypedData, isPending: false }),
  useConnect: () => ({ connectors: [{ id: "walletConnect" }], connect: vi.fn(), isPending: false }),
}));
vi.mock("@rainbow-me/rainbowkit", () => ({
  ConnectButton: { Custom: () => null },
  RainbowKitProvider: ({ children }: { children: ReactNode }) => children,
  lightTheme: () => ({ colors: {} }),
}));

const MEMBER = "0x1000000000000000000000000000000000000001";
const SENDER = "0x4000000000000000000000000000000000000004";
const CHAIN = {
  chainId: 1,
  label: "Ethereum Mainnet",
  isDevNode: false,
  explorerUrl: "https://etherscan.io",
  l2ExplorerUrl: null,
};
const onPage = (node: ReactNode) => (
  <ChainContext.Provider value={CHAIN}>{node}</ChainContext.Provider>
);
const execution = (simulation: unknown = { status: "ok" }) =>
  ({
    to: MEMBER,
    data: "0x1234",
    value: "0",
    functionName: "approve",
    simulation,
  }) as never;

beforeEach(() => {
  wallet.address = undefined;
  wallet.chainId = undefined;
  walletSend.sendTransaction.mockReset();
  walletSign.signTypedData.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the wallet's RPC", () => {
  it("is an address that never resolves, for every chain: nothing WalletConnect's provider forwards reaches a public RPC", () => {
    for (const chain of [
      chainFor(1, "Ethereum"),
      chainFor(11155111, "Sepolia"),
      chainFor(5, "X"),
    ]) {
      expect(chain.rpcUrls.default.http).toEqual(["https://wallet-rpc.invalid"]);
      // wagmi's WalletConnect connector puts the transport's URL in its rpcMap, else the chain's
      // first (@wagmi/core extractRpcUrls): the transport has none.
      expect((noBrowserRpc({ chain }).value as { url?: string } | undefined)?.url).toBeUndefined();
    }
    // The chain stays the one viem knows (name, explorer).
    expect(chainFor(1, "x").name).toBe("Ethereum");
  });
});

describe("sending", () => {
  it("goes out with this page's chain, and waits while the wallet is on another one", () => {
    wallet.address = SENDER;
    wallet.chainId = 42161;
    const { rerender } = render(onPage(<ExecutionPanel execution={execution()} />));
    expect(screen.getByTestId("send-transaction")).toBeDisabled();
    expect(screen.getByTestId("send-wrong-chain")).toHaveTextContent(
      "Your wallet is on another network (chain 42161). Switch it to Ethereum Mainnet first"
    );
    wallet.chainId = 1;
    rerender(onPage(<ExecutionPanel execution={execution()} />));
    expect(screen.queryByTestId("send-wrong-chain")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("send-transaction"));
    expect(walletSend.sendTransaction).toHaveBeenCalledWith(
      { to: MEMBER, data: "0x1234", value: 0n, chainId: 1 },
      expect.anything()
    );
  });

  it("asks before sending what the panel's own simulation says reverts", () => {
    wallet.address = SENDER;
    wallet.chainId = 1;
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    render(
      onPage(<ExecutionPanel execution={execution({ status: "reverted", error: "Not enough" })} />)
    );
    fireEvent.click(screen.getByTestId("send-transaction"));
    expect(confirm.mock.calls[0]?.[0]).toContain("would revert (Not enough)");
    expect(walletSend.sendTransaction).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByTestId("send-transaction"));
    expect(walletSend.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("knows a Safe{Wallet} peer by its origin, never by a name that merely contains Safe", () => {
    const origins = ["https://app.safe.global"];
    expect(isSafeWalletPeer("https://app.safe.global/home?safe=eth:0x1", origins)).toBe(true);
    expect(isSafeWalletPeer("https://www.safepal.com", origins)).toBe(false);
    expect(isSafeWalletPeer("https://app.safe.global.evil.example", origins)).toBe(false);
    expect(isSafeWalletPeer(undefined, origins)).toBe(false);
  });
});

describe("the review before signing", () => {
  const typedData = {
    domain: {
      name: "SecurityCouncil",
      version: "1",
      chainId: 1,
      verifyingContract: "0x59195219d1176E42f8e607e9AC114926D47f9035",
    },
    types: { ApproveUpgradeSecurityCouncil: [{ name: "id", type: "bytes32" }] },
    primaryType: "ApproveUpgradeSecurityCouncil",
    message: { id: `0x${"1".repeat(64)}` },
  } as never;
  const member = (domainSeparatorMatches: boolean) =>
    ({
      member: MEMBER,
      label: null,
      safe: {
        isContract: true,
        version: "1.3.0",
        threshold: 2,
        owners: [],
        domainSeparatorMatches,
      },
      hashes: {
        domainHash: `0x${"d".repeat(64)}`,
        messageHash: `0x${"e".repeat(64)}`,
        safeMessageHash: `0x${"f".repeat(64)}`,
      },
      status: "missing",
    }) as never;
  const button = (matches: boolean) =>
    onPage(
      <SignButton
        typedData={typedData}
        signerGroup="securityCouncil"
        members={[member(matches)]}
        disabledReason={null}
        open
      />
    );

  it("names the domain's chain, and warns when the Safe's own domain separator differs", () => {
    wallet.address = MEMBER;
    wallet.chainId = 1;
    const { rerender } = render(button(true));
    expect(screen.getByTestId("review-chain")).toHaveTextContent("chain 1 (Ethereum Mainnet)");
    expect(screen.queryByTestId("domain-separator-differs")).not.toBeInTheDocument();
    rerender(button(false));
    expect(screen.getByTestId("domain-separator-differs")).toHaveTextContent(
      "Do not sign until this is explained."
    );
  });

  it("sends nothing to sign while the wallet is on another network", () => {
    wallet.address = MEMBER;
    wallet.chainId = 10;
    render(button(true));
    expect(screen.getByTestId("sign-button")).toBeDisabled();
    expect(screen.getByTestId("sign-wrong-chain")).toHaveTextContent("chain 10");
    expect(screen.getByTestId("confirm-sign")).toBeDisabled();
  });
});

describe("what the page says about the values it is given", () => {
  it("flags veto link values that cannot work or lose funds", () => {
    const ok = { ...VETO_DEFAULTS, refundRecipient: SENDER };
    expect(vetoValueWarnings(ok)).toEqual([]);
    const odd = vetoValueWarnings({
      l2GasLimit: (10n ** 27n).toString(),
      l2GasPerPubdataByteLimit: "1",
      txMintValue: (10n ** 30n).toString(),
      refundRecipient: "0x0000000000000000000000000000000000000000",
    });
    expect(odd).toHaveLength(4);
    expect(odd.join(" ")).toMatch(/far above.*accepts only 800.*more than 1 ETH.*zero address/);
    expect(vetoValueWarnings({ ...ok, txMintValue: "0" })).toEqual([
      "The mint value is 0: it cannot pay for the L1 → L2 transaction.",
    ]);
  });

  it("flags a freeze request valid for more than a week", () => {
    const now = 1_790_000_000;
    expect(longValidityWarning(now + 2 * 86_400, now)).toBeNull();
    expect(longValidityWarning(now + 30 * 86_400, now)).toMatch(/^Valid for 30 days:/);
    expect(longValidityWarning((10n ** 30n).toString(), now)).toMatch(
      /^Valid for more than 100 years:/
    );
  });

  it("names the RPC by its host only, never its path, query or credentials", () => {
    expect(rpcHostLabel("https://mainnet.infura.io/v3/secret-key")).toBe("infura.io");
    expect(rpcHostLabel("https://eth-mainnet.g.alchemy.com/v2/secret")).toBe("alchemy.com");
    expect(rpcHostLabel("https://user:pass@acct-123.quiknode.pro/token/")).toBe("quiknode.pro");
    expect(rpcHostLabel("http://127.0.0.1:8547/secret")).toBe("http://127.0.0.1:8547");
    expect(rpcHostLabel("http://localhost:8545")).toBe("http://localhost:8545");
    expect(rpcHostLabel("https://rpc.not-configured.invalid")).toBeNull();
    expect(rpcHostLabel("not a url")).toBeNull();
  });

  it("when the contracts cannot be read, names the RPC's host and links to Settings", () => {
    render(<StatusProblem error="HTTP request failed." hint="Check it." rpc="infura.io" />);
    expect(screen.getByTestId("problem-rpc")).toHaveTextContent("L1 RPC: infura.io");
    expect(screen.getByTestId("problem-settings")).toHaveAttribute("href", "/settings");
  });
});
