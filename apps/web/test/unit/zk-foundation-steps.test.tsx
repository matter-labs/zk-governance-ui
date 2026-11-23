import { zkFoundationCall } from "@/common/execution";
import { ChainContext } from "@/components/governance-context";
import { ApprovalGroups } from "@/components/verification/signature-set";
import { ZkFoundationRows } from "@/components/verification/zk-foundation-steps";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import "@testing-library/jest-dom";
import { describe, expect, it } from "vitest";

// The ZK Foundation's steps in a standard upgrade, as rows of its Approvals table beside the
// Security Council's: no signatures are collected for them, only the call its Safe makes to the
// handler, shown in full to compare with that Safe transaction; while a step is open, that call
// simulated from the Safe; once done, the transaction that made it; closed, why.

type Steps = ComponentProps<typeof ZkFoundationRows>["zkFoundation"];
type Step = Steps["steps"][number];

const HANDLER = "0xE30Dca3047B37dc7d88849dE4A4Dc07937ad5Ab3";
const SAFE = "0x9000000000000000000000000000000000000009";
const ID = `0x${"ab".repeat(32)}` as const;
const TX = `0x${"cd".repeat(32)}` as const;
// approveUpgradeZkFoundation(bytes32) and extendLegalVeto(bytes32), each with the id.
const APPROVE_DATA = `0xb75a2103${"ab".repeat(32)}`;
const EXTEND_DATA = `0xb429f41c${"ab".repeat(32)}`;

const approval = (state: Step["state"], simulation: Step["simulation"] = null): Step => ({
  key: "approval",
  title: "ZK Foundation approval",
  state,
  call: zkFoundationCall(HANDLER, "approveUpgradeZkFoundation", ID),
  simulation,
});
const legalVeto = (state: Step["state"]): Step => ({
  key: "legalVeto",
  title: "Legal veto extension (ZK Foundation)",
  state,
  call: zkFoundationCall(HANDLER, "extendLegalVeto", ID),
  simulation: null,
});
const CLOSED_VETO = legalVeto({
  status: "closed",
  detail: "Only possible during the legal veto period",
});

/** The rows in the Approvals table, as the upgrade page shows them. */
function show(steps: Step[]) {
  return render(
    <ChainContext.Provider
      value={{
        chainId: 1,
        label: "Ethereum Mainnet",
        isDevNode: false,
        explorerUrl: "https://etherscan.io",
        l2ExplorerUrl: null,
      }}
    >
      <ApprovalGroups
        title="Approvals"
        heading="h2"
        count={steps.length}
        closed={steps.filter((s) => s.state.status === "closed").length}
      >
        <ZkFoundationRows zkFoundation={{ safe: SAFE, steps }} />
      </ApprovalGroups>
    </ChainContext.Provider>
  );
}

const header = (row: HTMLElement) => within(row).getAllByRole("button")[0] as HTMLElement;

describe("the ZK Foundation's rows in the Approvals table", () => {
  it("open: unfolded, with the Safe, the handler, the function, the full calldata and the call simulated from the Safe", () => {
    show([approval({ status: "open" }, { status: "ok", atBlock: "21000000" }), CLOSED_VETO]);
    expect(screen.getByTestId("approval-groups")).toHaveTextContent("Approvals · 2");
    const row = screen.getByTestId("zk-foundation-approval");
    expect(header(row)).toHaveAttribute("aria-expanded", "true");
    expect(row).toHaveTextContent("ZK Foundation approval");
    expect(row).toHaveTextContent("Open for its Safe");
    expect(within(row).getByTestId("zk-foundation-kind")).toHaveTextContent("Safe transaction");
    expect(row).toHaveTextContent("Not approved yet");
    expect(row).toHaveTextContent(`ZKsync Foundation Safe${SAFE}`);
    expect(row).toHaveTextContent(`ProtocolUpgradeHandler${HANDLER}`);
    expect(row).toHaveTextContent("approveUpgradeZkFoundation(bytes32 _id)");
    // In full: the signer compares it with the Safe transaction character by character.
    expect(within(row).getByTestId("zk-foundation-data").textContent).toBe(APPROVE_DATA);
    expect(row).toHaveTextContent("Sent from the ZKsync Foundation Safe:");
    expect(within(row).getByTestId("simulation-ok")).toHaveTextContent(
      "Simulated at block #21,000,000: the transaction would succeed."
    );
  });

  it("a closed step beside an open one is folded away under Show closed groups, with its reason", () => {
    show([approval({ status: "open" }, { status: "ok", atBlock: "21000000" }), CLOSED_VETO]);
    const closed = screen.getByTestId("zk-foundation-legalVeto");
    expect(closed).not.toBeVisible();
    fireEvent.click(screen.getByTestId("toggle-closed"));
    expect(closed).toBeVisible();
    expect(closed).toHaveTextContent("Closed");
    expect(closed).toHaveTextContent("Only possible during the legal veto period");
    expect(closed).toHaveTextContent("No transaction needed");
    // Folded, its call is still there to unfold, and nothing is simulated for it.
    expect(header(closed)).toHaveAttribute("aria-expanded", "false");
    expect(closed).toHaveTextContent("extendLegalVeto(bytes32 _id)");
    expect(within(closed).getByTestId("zk-foundation-data").textContent).toBe(EXTEND_DATA);
    expect(closed).not.toHaveTextContent("Sent from the ZKsync Foundation Safe");
  });

  it("done: folded, what the handler records and the transaction that made the call, with no simulation", () => {
    const { unmount } = show([
      approval({
        status: "done",
        detail: "Approved by the ZK Foundation",
        txHash: TX,
        at: "1792500000",
      }),
    ]);
    const row = screen.getByTestId("zk-foundation-approval");
    expect(header(row)).toHaveAttribute("aria-expanded", "false");
    expect(row).toHaveTextContent("Done on-chain");
    expect(row).toHaveTextContent("Approved by the ZK Foundation");
    expect(within(row).getByTestId("executed-on")).toHaveTextContent("Oct 20, 2026, 12:40 UTC");
    expect(within(row).getByTitle(TX).querySelector("a")).toHaveAttribute(
      "href",
      `https://etherscan.io/tx/${TX}`
    );
    // Its call stays to compare with; nothing is simulated once it is done.
    expect(within(row).getByTestId("zk-foundation-data").textContent).toBe(APPROVE_DATA);
    expect(row).not.toHaveTextContent("Sent from the ZKsync Foundation Safe");
    expect(within(row).queryByTestId("simulation-ok")).toBeNull();
    unmount();

    // Done, its transaction not found: recorded on-chain, never a link.
    show([
      legalVeto({ status: "done", detail: "Legal veto period extended to 7 days", txHash: null }),
    ]);
    const extended = screen.getByTestId("zk-foundation-legalVeto");
    expect(extended).toHaveTextContent("Legal veto period extended to 7 days");
    expect(extended).toHaveTextContent("Recorded on-chain");
    expect(extended.querySelector("a[href*='/tx/']")).toBeNull();
  });

  it("an open step whose simulation reverts says so in the row", () => {
    show([approval({ status: "open" }, { status: "reverted", error: "Upgrade is not waiting" })]);
    const row = screen.getByTestId("zk-foundation-approval");
    expect(row).toHaveTextContent("Would revert if sent now");
    expect(within(row).getByTestId("simulation-reverted")).toBeInTheDocument();
  });

  it("Typed data: the ZK Foundation signs a Safe transaction, shown as its call", () => {
    show([approval({ status: "open" }, { status: "ok", atBlock: "21000000" }), CLOSED_VETO]);
    fireEvent.click(screen.getByRole("button", { name: "Typed data" }));
    const row = screen.getByTestId("zk-foundation-approval");
    expect(row).toHaveTextContent("ZK Foundation approvalSafe transaction, no typed data");
    expect(within(row).getByTestId("zk-foundation-data").textContent).toBe(APPROVE_DATA);
    expect(row).toHaveTextContent(`ProtocolUpgradeHandler${HANDLER}`);
  });
});
