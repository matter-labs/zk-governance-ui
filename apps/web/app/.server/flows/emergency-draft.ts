import type { Address, Hex } from "viem";
import { NoContract, requireCode } from "../chain/call";
import { governance } from "../governance";
import { latestBlock } from "../rpc";
import { simulateCall } from "../signatures";

// The proposer's check of a draft emergency upgrade: each call as an eth_call from the
// ProtocolUpgradeHandler, which is who executes them, all at one block (the head, named in the
// answer; at "latest" when the head cannot be read). Opt-in: it sends the calls to this app's RPC.
// A call to an address without code also "succeeds" (call.ts): it is said, never a success, unless
// it only sends value.

export type DraftCallCheck =
  | { ok: true }
  | { ok: false; error: string }
  /** No answer (an RPC failure, a rate limit, out of gas), or no contract: never a revert. */
  | { ok: null; skipped: string };

export const NO_CONTRACT =
  "no contract at this address, so the call runs no code (a mistyped target, or another chain's)";

export async function checkDraftCalls(
  calls: readonly { target: Address; value: bigint; data: Hex }[]
): Promise<{ results: DraftCallCheck[]; atBlock: string | null }> {
  const [gov, head] = await Promise.all([governance(), latestBlock().catch(() => null)]);
  const results = await Promise.all(
    calls.map(async (call): Promise<DraftCallCheck> => {
      const [simulation, code] = await Promise.all([
        simulateCall({
          from: gov.upgradeHandler,
          to: call.target,
          data: call.data,
          value: call.value,
          ...(head ? { blockNumber: head.number } : {}),
        }),
        codeAt(call.target, head?.number),
      ]);
      switch (simulation.status) {
        case "reverted":
          return { ok: false, error: simulation.error };
        case "skipped":
          return { ok: null, skipped: simulation.reason };
        case "ok":
          if (code === true) return { ok: true };
          // A plain transfer to an account: nothing to run.
          if (code === false) {
            return call.data === "0x" && call.value > 0n
              ? { ok: true }
              : { ok: null, skipped: NO_CONTRACT };
          }
          return { ok: null, skipped: `RPC error: ${code.message}` };
      }
    })
  );
  return { results, atBlock: head ? head.number.toString() : null };
}

/** Whether `target` has code there, or the error that kept it from being read. */
async function codeAt(target: Address, blockNumber?: bigint): Promise<boolean | Error> {
  try {
    await requireCode(target, blockNumber);
    return true;
  } catch (error) {
    if (error instanceof NoContract) return false;
    return error instanceof Error ? error : new Error(String(error));
  }
}
