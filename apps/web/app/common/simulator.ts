import {
  type Address,
  type Hex,
  getAddress,
  isAddress,
  isAddressEqual,
  isHex,
  parseEther,
} from "viem";

/**
 * A transaction-simulator file (github.com/matter-labs/transaction-simulator): a JSON array of the
 * transactions to simulate, each sent by `from` on `network` ("mainnet", "sepolia", "zksync", …),
 * with `value` in ETH, and fields for the simulation only (valueToMint, testOnly, …).
 */
export type SimulatorTransaction = {
  network: string;
  from: string;
  to: string;
  data: string;
  value?: string | number;
  testOnly?: boolean;
  tag?: string;
};

export function isSimulatorFile(raw: unknown): raw is SimulatorTransaction[] {
  return (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every(
      (t) =>
        !!t &&
        typeof t === "object" &&
        typeof t.network === "string" &&
        typeof t.from === "string" &&
        typeof t.to === "string" &&
        typeof t.data === "string"
    )
  );
}

export type SimulatorCalls =
  | {
      ok: true;
      /** As a payload has them: values in wei. */
      calls: { target: Address; value: string; data: Hex }[];
      /** What was taken and what was left out, in a line. */
      summary: string;
    }
  | { ok: false; error: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * A governance upgrade's calls in the file: the transactions the ProtocolUpgradeHandler sends on
 * this L1, in file order (an upgrade's stages, stage0 to stage2), never a test-only one. The rest
 * (other senders, such as a ChainAdmin, and other networks) are other wallets' to send.
 */
export function simulatorCalls(
  file: readonly SimulatorTransaction[],
  { network, handler }: { network: string; handler: Address }
): SimulatorCalls {
  const calls: { target: Address; value: string; data: Hex }[] = [];
  const tags = new Map<string, number>();
  let left = 0;
  for (const [i, tx] of file.entries()) {
    const sent = tx.network === network && isAddress(tx.from) && isAddressEqual(tx.from, handler);
    if (!sent || tx.testOnly === true) {
      left++;
      continue;
    }
    if (!isAddress(tx.to))
      return { ok: false, error: `Transaction ${i + 1}: "to" is not an address.` };
    if (!isHex(tx.data)) return { ok: false, error: `Transaction ${i + 1}: "data" is not hex.` };
    let value: bigint;
    try {
      value = parseEther(String(tx.value ?? "0"));
    } catch {
      return {
        ok: false,
        error: `Transaction ${i + 1}: "value" ${tx.value} is not an amount in ETH.`,
      };
    }
    calls.push({ target: getAddress(tx.to), value: value.toString(), data: tx.data });
    if (tx.tag) tags.set(tx.tag, (tags.get(tx.tag) ?? 0) + 1);
  }
  if (calls.length === 0)
    return {
      ok: false,
      error: `No transaction in this transaction-simulator file is sent by the ProtocolUpgradeHandler ${handler} on ${network}, and those are a governance upgrade's calls.`,
    };
  const byTag = [...tags].map(([tag, n]) => `${tag} ${n}`).join(", ");
  return {
    ok: true,
    calls,
    summary: `${plural(calls.length, "call")} the ProtocolUpgradeHandler sends${byTag ? ` (${byTag})` : ""}${
      left
        ? `; ${plural(left, "other transaction")} left out (other senders or networks, or test-only)`
        : ""
    }.`,
  };
}
