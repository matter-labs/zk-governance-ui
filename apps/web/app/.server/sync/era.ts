import { isIndexedL2Governor } from "../chain/l2-index";
import { knownGovernors } from "../flows/l2";
import { type L2Head, l2, lastL2Head, network, refreshL2ChainHead, rpcGeneration } from "../rpc";
import { noteEraContent } from "./content-engine";
import { isL2Key } from "./presence";

// ZKsync Era while a page showing it is on screen (the upgrades that can start, `list:startable`),
// and only then: a timer reads Era's head every minute ('finalized' every 32 reads), and at it the
// governor index's tail and what those pages show (the startable upgrades with their proofs), so
// pages answer from memory (labelled "Era block #E · read Xs ago") and learn of a change by their
// next beat. Nothing while no such page is on screen or nobody uses the app; JSON reads Era on
// demand (its head at most 4 s old), as before.

/** The Era timer's period. */
export const ERA_EVERY_MS = 60_000;
// 'finalized' is read again every this many reads (finality only moves forward meanwhile).
const FINALIZED_EVERY = 32;

export type EraDriver = {
  /** The sync engine follows the chain and someone uses the app. */
  active: () => boolean;
  /** The keys on screen now. */
  keys: () => ReadonlySet<string>;
};

let driver: EraDriver | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;
let reads = 0;
let generation = -1;
let lastRunAt: number | null = null;

/** The Era keys on screen now (none while nobody uses the app). */
function eraKeys(): string[] {
  const current = driver;
  if (!current?.active()) return [];
  return [...current.keys()].filter(isL2Key);
}

/**
 * Starts the Era timer (idempotent): a run now when an Era page is on screen and the last run is
 * older than a minute, then every minute while one is. It stops by itself.
 */
export function startEraWatch(next: EraDriver) {
  driver = next;
  if (generation !== rpcGeneration()) {
    generation = rpcGeneration();
    reads = 0;
    lastRunAt = null;
  }
  if (timer !== null || running !== null) return;
  if (eraKeys().length === 0) return;
  const since = lastRunAt === null ? Number.POSITIVE_INFINITY : Date.now() - lastRunAt;
  // A clock stepped back counts as a minute gone.
  schedule(since >= ERA_EVERY_MS || since < 0 ? 0 : ERA_EVERY_MS - since);
}

/** Stops for good (the engine stopped): no timer is left; the next start reads Era at once. */
export function stopEraWatch() {
  driver = null;
  if (timer) clearTimeout(timer);
  timer = null;
  lastRunAt = null;
  reads = 0;
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  const next = setTimeout(() => void tick(), Math.max(0, ms));
  (next as { unref?: () => void }).unref?.();
  timer = next;
}

async function tick() {
  timer = null;
  if (eraKeys().length === 0) return;
  await run();
  if (driver && eraKeys().length > 0 && timer === null) schedule(ERA_EVERY_MS);
}

/** One read of Era for what is on screen (one at a time). */
function run(): Promise<void> {
  running ??= readEra().finally(() => {
    running = null;
  });
  return running;
}

async function readEra(): Promise<void> {
  const started = generation;
  const current = () => started === rpcGeneration() && eraKeys().length > 0;
  try {
    await eraPass(eraKeys(), current);
    lastRunAt = Date.now();
  } catch {
    // Era could not be read: pages read it on demand; the next minute tries again.
  }
}

/**
 * One read of Era for these keys: Era's head ('latest'; 'finalized' every 32 reads, and while none
 * is known), then at it the governor index's tail and what the pages with these keys show (noted
 * for their revisions). null when no governor is indexed (or no L2 RPC): pages then read Era on
 * demand. Rejects when Era's head cannot be read.
 */
export async function eraPass(
  keys: readonly string[],
  current: () => boolean = () => true
): Promise<{ at: L2Head } | null> {
  if (!(await l2())) return null;
  const net = await network();
  const governors = await knownGovernors();
  if (!governors.some((g) => isIndexedL2Governor(net, g.address))) return null;
  const at = await refreshL2ChainHead({ withFinalized: reads % FINALIZED_EVERY === 0 });
  reads++;
  // Era without the 'finalized' tag: nothing is indexed at its heads (flows scan on demand).
  if (!at || at.safe < 0n || !current()) return null;
  await noteEraContent(keys, current);
  return { at };
}

export type EraWatchStatus = {
  /** Era pages on screen (keys). */
  onScreen: number;
  /** The newest Era head read (number) and when Era answered (ISO), or null. */
  eraBlock: string | null;
  readAt: string | null;
};

/** What the Era timer does, for /api/status (sync.l2). */
export function eraWatchStatus(): EraWatchStatus {
  const head = lastL2Head();
  return {
    onScreen: eraKeys().length,
    eraBlock: head ? head.head.number.toString() : null,
    readAt: head ? new Date(head.answeredAt).toISOString() : null,
  };
}
