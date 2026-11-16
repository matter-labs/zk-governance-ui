import type { Hex } from "viem";
import { peek } from "../cache";
import { heldEmergencyList } from "../flows/emergency";
import { heldFreezeList } from "../flows/freeze";
import { notStartedUpgrades } from "../flows/l2";
import { listStandardUpgrades } from "../flows/standard";
import { pageGovernance } from "../page-governance";
import { type BlockRef, network } from "../rpc";
import { appStatus } from "../status";
import { type UpgradeStatusRead, upgradeStatusKey } from "../upgrade-status";
import {
  emergencyListContent,
  freezeListContent,
  idContent,
  startableContent,
  statusContent,
  upgradeListContent,
} from "./content";
import { ReceiptLost, receiptContent, receiptView, resetReceipts } from "./receipt";
import { isL2Key, startableDaysOf } from "./presence";
import { noteContent } from "./revs";

// The sync engine's passes over what is on screen: at each served head, from memory, and for
// ZKsync Era on its timer.

const ID = /^(upgrade|emergency):(0x[0-9a-f]{64})$/;
const TX = /^tx:(0x[0-9a-f]{64})$/;

// Notes what memory holds at the served head for each key on screen; a key whose content is not in
// memory keeps its revision (nothing is noted from an unknown value). Transaction receipts are read
// here, once per head while their page is on screen, until found. Never rejects.
export async function noteOnScreenContent(
  head: BlockRef,
  keys: Iterable<string>,
  current: () => boolean = () => true
): Promise<{ noted: number; skipped: number }> {
  const tally = { noted: 0, skipped: 0 };
  const at = { head: head.number };
  const net = await network();
  await Promise.all(
    [...keys].map(async (key) => {
      try {
        const noted = await noteKey(key, head, at, net.chainId, current);
        if (noted) tally.noted++;
        else tally.skipped++;
      } catch {
        tally.skipped++;
      }
    })
  );
  return tally;
}

async function noteKey(
  key: string,
  head: BlockRef,
  at: { head: bigint },
  chainId: number,
  current: () => boolean
): Promise<boolean> {
  if (key === "status") {
    const status = await appStatus({ freshness: "page" });
    if (!status.ok || !current()) return false;
    noteContent(key, { head: BigInt(status.governance.latestBlock.number) }, statusContent(status));
    return true;
  }
  const id = ID.exec(key);
  if (id) {
    const read = peek<UpgradeStatusRead>(upgradeStatusKey(chainId, id[2] as Hex, head));
    const value = read ? await read.catch(() => null) : null;
    if (!value || !current()) return false;
    noteContent(key, at, idContent(value));
    return true;
  }
  const upgrades = /^list:upgrades(?::(90|all))?$/.exec(key);
  if (upgrades) {
    const list = await listStandardUpgrades({
      allHistory: upgrades[1] === "all",
      days: upgrades[1] === "90" ? 90n : undefined,
      freshness: "page",
    });
    if (list.fromLastRun || !current()) return false;
    noteContent(key, at, upgradeListContent(list));
    return true;
  }
  if (key === "list:emergency" || key === "list:emergency:all") {
    const list = await heldEmergencyList({ allHistory: key.endsWith(":all") });
    if (!list || !current()) return false;
    noteContent(
      key,
      readAt(at, list.governance),
      emergencyListContent(list.pending, list.executed)
    );
    return true;
  }
  if (key === "list:freeze") {
    const list = await heldFreezeList();
    if (!list || !current()) return false;
    noteContent(key, readAt(at, list.governance), freezeListContent(list));
    return true;
  }
  const tx = TX.exec(key);
  if (tx) {
    // A failed read notes nothing (never "not mined" from a failure); a receipt found before but
    // not now is noted as unread: the page reloads and says so (never the old one as current).
    const receipt = await receiptView(tx[1] as Hex).then(
      (receipt) => ({ receipt, unread: false }),
      (error: unknown) => {
        if (error instanceof ReceiptLost) return { receipt: null, unread: true };
        throw error;
      }
    );
    if (!current()) return false;
    noteContent(key, at, receiptContent(receipt));
    return true;
  }
  return false;
}

// A list built on governance is noted at the block its governance was read at when that is older
// than the head: never at a head it was not read at.
export function readAt(at: { head: bigint }, gov: { latestBlock: { number: string } }) {
  const read = BigInt(gov.latestBlock.number);
  return { head: read < at.head ? read : at.head };
}

// The Era timer's pass over the Era keys on screen (the startable lists). Never rejects.
export async function noteEraContent(
  keys: Iterable<string>,
  current: () => boolean = () => true
): Promise<{ noted: number }> {
  let noted = 0;
  await Promise.all(
    [...keys].filter(isL2Key).map(async (key) => {
      try {
        const days = startableDaysOf(key);
        if (days === null) return;
        const items = await notStartedUpgrades({ page: true, days });
        if (!current()) return;
        const head = BigInt((await pageGovernance()).latestBlock.number);
        noteContent(key, { head }, startableContent(items));
        noted++;
      } catch {
        // Not read now: the key keeps its revision, and the next pass tries again.
      }
    })
  );
  return { noted };
}

export function resetContent() {
  resetReceipts();
}
