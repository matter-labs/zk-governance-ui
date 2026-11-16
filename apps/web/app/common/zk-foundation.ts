import { UPGRADE_STATES, type UpgradeState } from "./upgrade-states";

// The ZK Foundation's two steps in a standard upgrade (ProtocolUpgradeHandler after ZIP-19). Its
// Safe calls the handler itself (msg.sender is checked): a Safe transaction its owners sign in that
// Safe, no signatures of its own. Shared by the server (each step's state, call and transaction)
// and the page (the Approvals table's count of closed rows, before those details arrive).

export const ZK_FOUNDATION_STEPS = [
  {
    key: "approval",
    title: "ZK Foundation approval",
    functionName: "approveUpgradeZkFoundation",
    event: "UpgradeApprovedByZkFoundation",
  },
  {
    key: "legalVeto",
    title: "Legal veto extension (ZK Foundation)",
    functionName: "extendLegalVeto",
    event: "UpgradeLegalVetoExtended",
  },
] as const;

export type ZkFoundationStepKey = (typeof ZK_FOUNDATION_STEPS)[number]["key"];

/** Done when the handler records it, open while the handler would take the call, else closed. */
export function zkFoundationStepStatus(
  key: ZkFoundationStepKey,
  state: UpgradeState,
  flags: { zkFoundationApproval: boolean; zkFoundationExtendedLegalVeto: boolean }
): "open" | "done" | "closed" {
  if (key === "approval")
    return flags.zkFoundationApproval
      ? "done"
      : state === UPGRADE_STATES.Waiting
        ? "open"
        : "closed";
  return flags.zkFoundationExtendedLegalVeto
    ? "done"
    : state === UPGRADE_STATES.LegalVetoPeriod
      ? "open"
      : "closed";
}
