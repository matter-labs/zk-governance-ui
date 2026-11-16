import { l1MessengerEventAbi, l2GovernorAbi, upgradeHandlerAbi } from "@/common/abis";
import type { L2Proposal } from "@/common/execution";
import { proposalSummary, proposalTitle } from "@/common/proposal-title";
import { STARTABLE_DAYS } from "@/common/startable";
import {
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  isAddressEqual,
  isHex,
  keccak256,
  numberToHex,
  toHex,
} from "viem";
import { getLogProof } from "viem/zksync";
import { FOREVER, cached, cachedUntil } from "../cache";
import {
  ERA_PAGE_MAX_AGE_MS,
  type L2GovernorEvent,
  eventsInWindow,
  isIndexedL2Governor,
  l2GovernorIndex,
  l2IndexHead,
} from "../chain/l2-index";
import { findBlockByTimestamp, getLogs } from "../logs";
import { type L2Head, l1, l2, network, servedHead } from "../rpc";
import { callTo, topicOf } from "./common";
import { L1_MESSENGER, findL2ProposalInBatch, upgradeBatch } from "./l2-batch";

// ZKsync Era side of governance: the protocol governor whose executed proposals start L1 upgrades.
// Its logs come from the L2 governor log index while it is the pinned one; a governor replaced
// through env, or any while Era lacks the 'finalized' tag, is scanned on demand. Results near the
// head are never cached for good. (The Token and GovOps governors are not read: since ZIP-19 the
// ZK Foundation vetoes their proposals with its own Safe on Era, nothing signed on L1.)

const DAY = 86_400n;
// An upgrade's L2 execution, before its L1 creation (legacy discovery).
const DISCOVERY_WINDOW = 21n * DAY;
// A proposal's state() read at an Era head is served while that head is (4 s).
const STATE_TTL_MS = 4_000;

// IGovernor.ProposalState
export const L2_PROPOSAL_STATES = [
  "Pending",
  "Active",
  "Canceled",
  "Defeated",
  "Succeeded",
  "Queued",
  "Expired",
  "Executed",
] as const;
export type L2ProposalStateName = (typeof L2_PROPOSAL_STATES)[number];

export type L2GovernorKind = "protocol";

export async function knownGovernors(): Promise<
  { kind: L2GovernorKind; name: string; address: Address }[]
> {
  const { l2Governors } = await network();
  return [
    { kind: "protocol" as const, name: "ZkProtocolGovernor", address: l2Governors.protocol },
  ].filter(
    (g): g is { kind: L2GovernorKind; name: string; address: Address } => g.address !== null
  );
}

// ---- governors that are not indexed: on-demand scans ----

async function l2Head(client: PublicClient) {
  return cached("l2-head", 4_000, () => client.getBlock({ blockTag: "latest" }));
}

async function l2BlockAt(client: PublicClient, timestamp: bigint) {
  const head = await l2Head(client);
  if (timestamp >= head.timestamp) return head.number;
  return findBlockByTimestamp(client, timestamp, 1n, head.number, {
    key: "l2",
    safeHead: head.number - 1_000n,
  });
}

/** `name` logs of `governor` in [from block, head] (scanned on demand, never cached). */
async function scanWindow(
  client: PublicClient,
  governor: Address,
  name: "ProposalCreated" | "ProposalExecuted",
  since: bigint
) {
  const head = await l2Head(client);
  const from = await l2BlockAt(client, head.timestamp - since);
  return getLogs(
    client,
    { address: governor, topics: [topicOf(l2GovernorAbi, name)] },
    from,
    head.number,
    { safeHead: -1n }
  );
}

// ---- proposals ----

export type L2ProposalView = L2Proposal & {
  governor: Address;
  governorName: string | null;
  proposalId: string;
  proposer: Address;
  state: L2ProposalStateName | null;
  voteStart: string;
  voteEnd: string;
  // hashProposal recomputed locally: must equal the id.
  idMatchesLocal: boolean;
  createdTx: Hex;
};

function hashL2Proposal(p: L2Proposal): bigint {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "address[]" }, { type: "uint256[]" }, { type: "bytes[]" }, { type: "bytes32" }],
        [p.targets, p.values.map(BigInt), p.calldatas, keccak256(toHex(p.description))]
      )
    )
  );
}

type CreatedLog = Pick<Log, "data" | "topics" | "transactionHash" | "blockHash" | "logIndex">;

type Created = {
  proposal: L2Proposal;
  proposalId: bigint;
  proposer: Address;
  voteStart: bigint;
  voteEnd: bigint;
  localId: bigint;
  createdTx: Hex;
};

function decodeCreated(log: CreatedLog): Created {
  const { args } = decodeEventLog({
    abi: l2GovernorAbi,
    eventName: "ProposalCreated",
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
  });
  const proposal: L2Proposal = {
    targets: args.targets.map((t) => getAddress(t)),
    values: args.values.map((v) => v.toString()),
    calldatas: [...args.calldatas],
    description: args.description,
  };
  return {
    proposal,
    proposalId: args.proposalId,
    proposer: getAddress(args.proposer),
    voteStart: args.voteStart,
    voteEnd: args.voteEnd,
    localId: hashL2Proposal(proposal),
    createdTx: log.transactionHash as Hex,
  };
}

/** decodeCreated, once per log: a block hash and a log index name one log for good. */
function createdOf(log: CreatedLog): Promise<Created> {
  if (!isHex(log.blockHash) || typeof log.logIndex !== "number")
    return Promise.resolve(decodeCreated(log));
  return cached(`l2-created:${log.blockHash.toLowerCase()}:${log.logIndex}`, FOREVER, async () =>
    decodeCreated(log)
  );
}

/** A log `fromLastRun` (not read in this run yet) is decoded for this answer only, never kept. */
async function viewOf(
  client: PublicClient,
  governor: Address,
  log: CreatedLog,
  at: L2Head | null,
  { fromLastRun = false, page = false }: { fromLastRun?: boolean; page?: boolean } = {}
): Promise<L2ProposalView> {
  const created = fromLastRun ? decodeCreated(log) : await createdOf(log);
  const readState = () =>
    client
      .readContract({
        address: governor,
        abi: l2GovernorAbi,
        functionName: "state",
        args: [created.proposalId],
      })
      // null only for a value outside IGovernor.ProposalState. A failed read fails the caller
      // (viem reports Era's code-3 revert and -32603 alike, so no failure here is an answer).
      .then((s) => L2_PROPOSAL_STATES[s] ?? null);
  const [state, governorName] = await Promise.all([
    at
      ? cached(
          // A page's read is kept apart from JSON's, for as long as pages answer at that head.
          `l2-state${page ? "-page" : ""}:${governor.toLowerCase()}:${created.proposalId}:${at.head.hash}`,
          page ? ERA_PAGE_MAX_AGE_MS : STATE_TTL_MS,
          readState
        )
      : readState(),
    knownGovernors().then(
      (gs) => gs.find((g) => isAddressEqual(g.address, governor))?.name ?? null
    ),
  ]);
  return {
    ...created.proposal,
    governor,
    governorName,
    proposalId: created.proposalId.toString(),
    proposer: created.proposer,
    state,
    voteStart: created.voteStart.toString(),
    voteEnd: created.voteEnd.toString(),
    idMatchesLocal: created.localId === created.proposalId,
    createdTx: created.createdTx,
  };
}

export const eraHeadOf = (at: L2Head | null) =>
  at && { number: at.head.number.toString(), readAt: new Date(at.answeredAt).toISOString() };

/** A specific L2 proposal's content, from its ProposalCreated log, with its state read now. */
export async function getL2Proposal(
  governor: Address,
  proposalId: bigint,
  options: { page?: boolean } = {}
): Promise<L2ProposalView | null> {
  return (await getL2ProposalAnswer(governor, proposalId, options)).proposal;
}

export async function getL2ProposalAnswer(
  governor: Address,
  proposalId: bigint,
  { page = false }: { page?: boolean } = {}
): Promise<{
  proposal: L2ProposalView | null;
  eraHead: { number: string; readAt: string } | null;
}> {
  const client = await l2();
  if (!client) return { proposal: null, eraHead: null };
  const net = await network();
  const at = isIndexedL2Governor(net, governor) ? await l2IndexHead(net, { page }) : null;
  if (at) {
    // The index holds every ProposalCreated of this governor up to the head: none for this id
    // means the governor has no such proposal, unless the Era RPC's log history is incomplete.
    const { head, events, historyMissing } = await l2GovernorIndex().read({ head: at });
    const event = events.find(
      (e) =>
        e.eventName === "ProposalCreated" &&
        isAddressEqual(e.governor, governor) &&
        e.proposalId === proposalId
    );
    if (!event && historyMissing !== null)
      throw new Error(
        `The ZKsync Era RPC returned no governor log at block ${historyMissing}, where they start: its log history is incomplete, so the proposal not being in it is no answer`
      );
    return {
      proposal: event ? await viewOf(client, governor, event.log, head, { page }) : null,
      eraHead: eraHeadOf(head),
    };
  }
  // Not indexed: found from its on-chain snapshot time.
  const proposal = await cached(`l2-proposal:${governor}:${proposalId}`, 5 * 60_000, async () => {
    const [snapshot, votingDelay] = await Promise.all([
      client.readContract({
        address: governor,
        abi: l2GovernorAbi,
        functionName: "proposalSnapshot",
        args: [proposalId],
      }),
      client.readContract({ address: governor, abi: l2GovernorAbi, functionName: "votingDelay" }),
    ]);
    if (snapshot === 0n) return null;
    // Created at snapshot - votingDelay, unless the delay changed since; widen the window for that.
    const from = await l2BlockAt(client, snapshot - votingDelay - 7n * DAY);
    const to = await l2BlockAt(client, snapshot);
    const logs = await getLogs(
      client,
      { address: governor, topics: [topicOf(l2GovernorAbi, "ProposalCreated")] },
      from,
      to,
      { safeHead: -1n }
    );
    // Only the matching proposal is read: another's failed state() read must not fail this one.
    const log = logs.find(
      (l) =>
        decodeEventLog({
          abi: l2GovernorAbi,
          eventName: "ProposalCreated",
          data: l.data,
          topics: l.topics,
        }).args.proposalId === proposalId
    );
    return log ? viewOf(client, governor, log, null) : null;
  });
  return { proposal, eraHead: null };
}

async function executedFromIndex(
  governor: Address,
  at: L2Head,
  since: bigint,
  until?: bigint
): Promise<L2GovernorEvent[]> {
  const { events } = await l2GovernorIndex().read({ head: at });
  const executed = events.filter(
    (e) => e.eventName === "ProposalExecuted" && isAddressEqual(e.governor, governor)
  );
  return eventsInWindow(executed, since, until);
}

/**
 * ZkProtocolGovernor proposal whose L2 → L1 message is the upgrade `l1Id` (for the Tally link),
 * with its title: the first line of its description (null when it cannot be read now).
 */
export async function findL2ProposalForUpgrade(
  l1Id: Hex,
  creationTimestamp: number,
  options: { startedTxHash?: Hex; strategy?: "batch" | "legacy"; page?: boolean } = {}
) {
  const match = await matchL2ProposalForUpgrade(l1Id, creationTimestamp, options);
  if (!match) return null;
  const description = await l2ProposalDescription(match.governor, BigInt(match.proposalId), {
    page: options.page,
  }).catch(() => null);
  return {
    ...match,
    title: description === null ? null : proposalTitle(description),
    summary: description === null ? null : proposalSummary(description),
  };
}

/**
 * From its ProposalCreated log: the index's when the governor is indexed, else read for it. A page
 * reads the index at Era's head as pages keep it (ERA_PAGE_MAX_AGE_MS), JSON at the newest.
 */
export async function l2ProposalTitle(
  governor: Address,
  proposalId: bigint,
  { page = false }: { page?: boolean } = {}
): Promise<string | null> {
  const description = await l2ProposalDescription(governor, proposalId, { page });
  return description === null ? null : proposalTitle(description);
}

async function l2ProposalDescription(
  governor: Address,
  proposalId: bigint,
  { page = false }: { page?: boolean } = {}
): Promise<string | null> {
  const net = await network();
  const at = isIndexedL2Governor(net, governor) ? await l2IndexHead(net, { page }) : null;
  if (!at) return (await getL2Proposal(governor, proposalId))?.description ?? null;
  const { events } = await l2GovernorIndex().read({ head: at });
  const event = events.find(
    (e) =>
      e.eventName === "ProposalCreated" &&
      isAddressEqual(e.governor, governor) &&
      e.proposalId === proposalId
  );
  return event ? (await createdOf(event.log)).proposal.description : null;
}

/** When an Era transaction was included: its block's time (seconds). */
export async function l2TxTime(txHash: Hex): Promise<number | null> {
  const client = await l2();
  if (!client) return null;
  return cached(`l2-tx-time:${txHash.toLowerCase()}`, 10 * 60_000, async () => {
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    return Number((await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
  });
}

async function matchL2ProposalForUpgrade(
  l1Id: Hex,
  creationTimestamp: number,
  { startedTxHash, strategy = "batch" }: { startedTxHash?: Hex; strategy?: "batch" | "legacy" } = {}
) {
  const client = await l2();
  const net = await network();
  const { l2Governors, isDevNode, upgradeHandler } = net;
  if (!client || !l2Governors.protocol) return null;
  const governor = l2Governors.protocol;
  // Found once and kept; on a dev node (rewound at will, which /resources/refresh follows) for a
  // minute, as pages read Era.
  return cached(
    `l2-for-upgrade:${strategy}:${l1Id}`,
    isDevNode ? 60_000 : Number.POSITIVE_INFINITY,
    async () => {
      if (strategy === "batch" && startedTxHash) {
        try {
          const call = await callTo(startedTxHash, upgradeHandler);
          const batch = call ? upgradeBatch(call.data, l1Id) : null;
          if (batch !== null) {
            const match = await findL2ProposalInBatch(client, l1Id, governor, batch);
            if (match) return match;
          }
        } catch {
          // Unsupported RPC methods or unavailable batch history retain the existing discovery path.
        }
      }
      const created = BigInt(creationTimestamp);
      // Executions in the 21 days before the upgrade's creation on L1. (Its own execution was
      // proven on L1 before then, so it is in a block timed before the creation.)
      const at = isIndexedL2Governor(net, governor) ? await l2IndexHead(net) : null;
      const logs: { log: Log; final: boolean }[] = at
        ? await executedFromIndex(governor, at, created - DISCOVERY_WINDOW, created)
        : await windowLogs(client, governor, created);
      for (const { log, final } of logs) {
        const message = await l1MessageOf(client, log.transactionHash as Hex, final);
        if (message && keccak256(message.body) === l1Id) {
          const { args } = decodeEventLog({
            abi: l2GovernorAbi,
            eventName: "ProposalExecuted",
            data: log.data,
            topics: log.topics,
          });
          return {
            governor,
            proposalId: args.proposalId.toString(),
            executedTx: log.transactionHash as Hex,
          };
        }
      }
      return null;
    }
  );
}

async function windowLogs(client: PublicClient, governor: Address, created: bigint) {
  const from = await l2BlockAt(client, created - DISCOVERY_WINDOW);
  const to = await l2BlockAt(client, created);
  const logs = await getLogs(
    client,
    { address: governor, topics: [topicOf(l2GovernorAbi, "ProposalExecuted")] },
    from,
    to,
    { safeHead: -1n }
  );
  return logs.map((log) => ({ log, final: false }));
}

/** Kept for good only when the execution is final: its receipt never changes. */
function l1MessageOf(client: PublicClient, txHash: Hex, final = false) {
  return final
    ? cached(`l2-message:${txHash.toLowerCase()}`, FOREVER, () => readL1Message(client, txHash))
    : readL1Message(client, txHash);
}

async function readL1Message(client: PublicClient, txHash: Hex) {
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const log = receipt.logs.find(
    (l) =>
      isAddressEqual(l.address, L1_MESSENGER) &&
      l.topics[0] === topicOf(l1MessengerEventAbi, "L1MessageSent")
  );
  if (!log) return null;
  const { args } = decodeEventLog({ abi: l1MessengerEventAbi, data: log.data, topics: log.topics });
  return { body: args._message, receipt };
}

// Kept once Era has it (it never changes once the batch is sealed), not while it is missing.
// Never rejects.
function logProofOf(client: PublicClient, txHash: Hex) {
  return cachedUntil(`l2-log-proof:${txHash.toLowerCase()}`, async () => {
    const proof = await getLogProof(client as never, { txHash, index: 0 }).catch(() => null);
    return { value: proof, ttlMs: proof ? FOREVER : 0 };
  });
}

export type NotStartedUpgrade = {
  l2ProposalId: Hex;
  executedTx: Hex;
} & (
  | {
      ok: true;
      l1ProposalId: Hex;
      data: {
        l2BatchNumber: Hex;
        l2MessageIndex: Hex;
        l2TxNumberInBatch: Hex | null;
        proof: Hex[];
        proposal: Hex;
      };
    }
  | { ok: false; error: string }
);

/**
 * Executed ZkProtocolGovernor proposals whose L1 upgrade has not been started yet, among those
 * executed in the last `days` days. With `page` (never JSON): at the Era head pages answer at,
 * kept for as long as they do.
 */
export async function notStartedUpgrades({
  page = false,
  days = STARTABLE_DAYS,
}: { page?: boolean; days?: number } = {}): Promise<NotStartedUpgrade[]> {
  const client = await l2();
  const net = await network();
  if (!client || !net.l2Governors.protocol) return [];
  const governor = net.l2Governors.protocol;
  const at = isIndexedL2Governor(net, governor) ? await l2IndexHead(net, { page }) : null;
  if (page && at)
    return cached(`startable-page:${days}:${at.head.hash.toLowerCase()}`, ERA_PAGE_MAX_AGE_MS, () =>
      readNotStarted(client, net, governor, at, days)
    );
  return readNotStarted(client, net, governor, at, days);
}

async function readNotStarted(
  client: PublicClient,
  net: Awaited<ReturnType<typeof network>>,
  governor: Address,
  at: L2Head | null,
  days: number
): Promise<NotStartedUpgrade[]> {
  const window = BigInt(days) * DAY;
  const logs: { log: Log; final: boolean }[] = at
    ? await executedFromIndex(governor, at, at.head.timestamp - window)
    : (await scanWindow(client, governor, "ProposalExecuted", window)).map((log) => ({
        log,
        final: false,
      }));
  const results = await Promise.all(
    logs.map(async ({ log, final }): Promise<NotStartedUpgrade | null> => {
      const { args } = decodeEventLog({
        abi: l2GovernorAbi,
        eventName: "ProposalExecuted",
        data: log.data,
        topics: log.topics,
      });
      const l2ProposalId = numberToHex(args.proposalId);
      const executedTx = log.transactionHash as Hex;
      const message = await l1MessageOf(client, executedTx, final);
      if (!message)
        return {
          l2ProposalId,
          executedTx,
          ok: false,
          error: "No L2 → L1 message in the execution",
        };
      const l1ProposalId = keccak256(message.body);
      // At the L1 head requests read now (not asking the node), or 'latest' when none is known.
      const head = await (servedHead() ?? Promise.resolve(null)).catch(() => null);
      const state = await l1.readContract({
        address: net.upgradeHandler,
        abi: upgradeHandlerAbi,
        functionName: "upgradeState",
        args: [l1ProposalId],
        ...(head && !net.isDevNode ? { blockNumber: head.number } : {}),
      });
      if (state !== 0) return null;
      // Era receipts carry batch fields (zksync formatters on the L2 client).
      const receipt = message.receipt as typeof message.receipt & {
        l1BatchNumber: bigint | null;
        l1BatchTxIndex: bigint | null;
      };
      if (receipt.l1BatchNumber === null) {
        return { l2ProposalId, executedTx, ok: false, error: "Not included in an L1 batch yet" };
      }
      const proof = await logProofOf(client, executedTx);
      if (!proof)
        return {
          l2ProposalId,
          executedTx,
          ok: false,
          error: "L2 → L1 log proof not available yet",
        };
      return {
        l2ProposalId,
        executedTx,
        ok: true,
        l1ProposalId,
        data: {
          l2BatchNumber: numberToHex(receipt.l1BatchNumber),
          l2MessageIndex: numberToHex(proof.id),
          l2TxNumberInBatch:
            receipt.l1BatchTxIndex !== null ? numberToHex(receipt.l1BatchTxIndex) : null,
          proof: proof.proof,
          proposal: message.body,
        },
      };
    })
  );
  return results.filter((r): r is NotStartedUpgrade => r !== null);
}
