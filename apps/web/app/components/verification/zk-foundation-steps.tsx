import type { ZkFoundationSteps } from "@/.server/flows/standard";
import { AddressLink, CopyButton } from "@/components/hex";
import { SetStateBadge } from "@/components/verification/badges";
import { SimulationResult } from "@/components/verification/execution-panel";
import {
  GROUP_COLUMNS,
  RESULT_TONE,
  RecordedOnChain,
  useGroups,
} from "@/components/verification/signature-set";
import type { SafeCall } from "@/components/verification/your-signature";
import { cn } from "@/utils/cn";
import type { SerializeFrom } from "@remix-run/node";
import { ChevronDown, XCircle } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

type Steps = SerializeFrom<ZkFoundationSteps>;
type Step = Steps["steps"][number];

const SIGNATURE: Record<string, string> = {
  approveUpgradeZkFoundation: "approveUpgradeZkFoundation(bytes32 _id)",
  extendLegalVeto: "extendLegalVeto(bytes32 _id)",
};

/**
 * The ZK Foundation's steps in a standard upgrade, as rows of its Approvals table beside the
 * Security Council's. No signatures reach the handler for them: the ZK Foundation's Safe calls the
 * handler itself (msg.sender is checked), a Safe transaction its owners sign in that Safe. Each row
 * says what the handler records and unfolds into the exact call to compare with that Safe
 * transaction, and while it is open, that call simulated from the Safe. Nothing is signed or sent
 * from here.
 */
export function ZkFoundationRows({ zkFoundation }: { zkFoundation: Steps }) {
  return (
    <>
      {zkFoundation.steps.map((step) => (
        <ZkFoundationRow key={step.key} step={step} safe={zkFoundation.safe} />
      ))}
    </>
  );
}

/** The steps as calls for "Your signature" to offer the ZKsync Foundation Safe, when connected. */
export function zkFoundationSafeCalls(zkFoundation: Steps): SafeCall[] {
  return zkFoundation.steps.map((step) => ({
    key: `zkFoundation-${step.key}`,
    title: step.title,
    safe: zkFoundation.safe,
    safeLabel: "ZKsync Foundation Safe",
    state: step.state,
    execution: { ...step.call, simulation: step.simulation },
    toLabel: "ProtocolUpgradeHandler",
  }));
}

/** In place of the rows while they are read, or when they could not be. */
export function ZkFoundationRowsNote({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-3.5 text-slate-500 text-sm" data-testid="zk-foundation-note">
      {children}
    </div>
  );
}

function ZkFoundationRow({ step, safe }: { step: Step; safe: string }) {
  const groups = useGroups();
  const { state, call, simulation } = step;
  const closed = state.status === "closed";
  // As a signer group's row: open, unfolded at first (unless the page folds them); done or
  // closed, folded. Expand / Collapse all decides after.
  const [open, setOpen] = useState(() =>
    groups.fold.v > 0 ? groups.fold.open : groups.unfoldOpen && state.status === "open"
  );
  useEffect(() => {
    if (groups.fold.v > 0) setOpen(groups.fold.open);
  }, [groups.fold]);
  const testId = `zk-foundation-${step.key}`;

  // Typed data: what each group signs. The ZK Foundation signs a Safe transaction, not typed data.
  if (groups.typed)
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50" data-testid={testId}>
        <p className="flex flex-wrap items-baseline gap-x-2 border-slate-200 border-b px-4 py-2 font-semibold text-[14px] text-navy-800">
          {step.title}
          <span className="font-normal text-[13px] text-slate-600">
            Safe transaction, no typed data
          </span>
        </p>
        <div className="px-4 py-3">
          <CallDetail call={call} safe={safe} />
        </div>
      </div>
    );

  return (
    <div
      data-testid={testId}
      data-closed={closed || undefined}
      hidden={closed && groups.hideClosed}
    >
      <div
        className={cn(
          "group/grow grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3.5 transition-colors hover:bg-slate-50",
          GROUP_COLUMNS,
          open && "bg-slate-50/70"
        )}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen(!open);
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${step.title}: a Safe transaction`}
      >
        <span className="col-start-1 row-start-1 min-w-0 space-y-1">
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span
              className={cn(
                "font-semibold text-[15px] decoration-slate-300 underline-offset-4 group-hover/grow:underline",
                closed ? "text-slate-600" : "text-navy-800"
              )}
            >
              {step.title}
            </span>
            <SetStateBadge state={state} open="Open for its Safe" />
          </span>
          {state.status !== "open" && (
            <span className="block text-[13px] text-slate-500">{state.detail}</span>
          )}
        </span>
        {/* The Signatures column: none here, the call comes from the Safe. */}
        <span className="col-start-1 row-start-2 min-w-0 md:col-start-2 md:row-start-1">
          <span
            className={cn(
              "block leading-6",
              state.status === "open"
                ? "font-semibold text-[15px] text-navy-800"
                : closed
                  ? "text-[14px] text-slate-500"
                  : "text-[14px] text-slate-700"
            )}
            data-testid="zk-foundation-kind"
          >
            Safe transaction
          </span>
        </span>
        {/* A link in it opens the transaction, not the row. */}
        <span
          className="col-start-1 row-start-3 min-w-0 md:col-start-3 md:row-start-1"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <StepResult step={step} />
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "col-start-2 row-start-1 h-4 w-4 text-slate-500 transition-transform md:col-start-4",
            open && "rotate-180"
          )}
        />
      </div>

      <div hidden={!open} className="border-slate-100 border-t">
        <div className="space-y-4 px-4 py-4 sm:px-5">
          <CallDetail call={call} safe={safe} />
          {state.status === "open" && simulation && (
            <div className="space-y-1.5">
              <p className="text-slate-600 text-xs">Sent from the ZKsync Foundation Safe:</p>
              <SimulationResult simulation={simulation} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The Result cell, in a word or two: the transaction once done, the simulation while open. */
function StepResult({ step }: { step: Step }) {
  const { state, simulation } = step;
  if (state.status === "done")
    return (
      <span className="block space-y-0.5" data-testid="done-summary">
        <RecordedOnChain state={state} stale={false} />
      </span>
    );
  if (state.status === "closed")
    return <span className={cn(RESULT_TONE, "text-slate-600")}>No transaction needed</span>;
  // Only a problem is said here; the simulation itself is in the unfolded row.
  if (simulation?.status === "reverted")
    return (
      <span className={cn(RESULT_TONE, "font-semibold text-red-900")}>
        <XCircle aria-hidden className="h-4 w-4 shrink-0" /> Would revert if sent now
      </span>
    );
  return (
    <span className={cn(RESULT_TONE, "text-slate-800")}>
      {step.key === "approval" ? "Not approved yet" : "Not extended yet"}
    </span>
  );
}

/** The call its Safe makes, in full: a signer compares it character by character. */
function CallDetail({ call, safe }: { call: Step["call"]; safe: string }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[110px_minmax(0,1fr)]">
      <Row label="From">
        <AddressLink address={safe} label="ZKsync Foundation Safe" />
      </Row>
      <Row label="To">
        <AddressLink address={call.to} label="ProtocolUpgradeHandler" />
      </Row>
      <Row label="Value">
        <span className="mono text-[13px]">{call.value}</span>
      </Row>
      <Row label="Function">
        <span className="mono text-[13px]">
          {SIGNATURE[call.functionName] ?? call.functionName}
        </span>
      </Row>
      <Row label="Data">
        <span className="inline-flex min-w-0 max-w-full items-start gap-1">
          <span className="mono min-w-0 break-all text-[13px]" data-testid="zk-foundation-data">
            {call.data}
          </span>
          <CopyButton value={call.data} label="Copy calldata" />
        </span>
      </Row>
    </dl>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5 sm:contents">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 text-slate-950">{children}</dd>
    </div>
  );
}
