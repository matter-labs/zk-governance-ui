import type { FreezeAction } from "./execution";

export const FREEZE_ACTIONS = [
  "SoftFreeze",
  "HardFreeze",
  "Unfreeze",
  "SetSoftFreezeThreshold",
] as const satisfies readonly FreezeAction[];

export const FREEZE_SLUGS: Record<FreezeAction, string> = {
  SoftFreeze: "soft-freeze",
  HardFreeze: "hard-freeze",
  Unfreeze: "unfreeze",
  SetSoftFreezeThreshold: "set-soft-freeze-threshold",
};

export const FREEZE_LABELS: Record<FreezeAction, string> = {
  SoftFreeze: "Soft freeze",
  HardFreeze: "Hard freeze",
  Unfreeze: "Unfreeze",
  SetSoftFreezeThreshold: "Set soft-freeze threshold",
};

export function freezeActionFromSlug(slug: string): FreezeAction | null {
  return (
    (Object.entries(FREEZE_SLUGS).find(([, s]) => s === slug)?.[0] as FreezeAction | undefined) ??
    null
  );
}

/** The request page for exactly these signed values. */
export function freezePath(params: {
  action: FreezeAction;
  nonce: string;
  validUntil: string;
  threshold?: string;
}) {
  const query = new URLSearchParams({ nonce: params.nonce, validUntil: params.validUntil });
  if (params.action === "SetSoftFreezeThreshold") query.set("threshold", params.threshold ?? "");
  return `/app/freeze/${FREEZE_SLUGS[params.action]}?${query}`;
}

// Signed, a request can be executed at any time until its validUntil unless its nonce is used
// first: one valid for longer than this is a standing one, said before anyone signs it.
const LONG_VALIDITY_S = 7n * 86_400n;

/** Why this request's validity needs a look, or null: more than a week after `now` (seconds). */
export function longValidityWarning(validUntil: string | number, now: string | number) {
  let left: bigint;
  try {
    left = BigInt(validUntil) - BigInt(now);
  } catch {
    return null;
  }
  if (left <= LONG_VALIDITY_S) return null;
  const days = left / 86_400n;
  return `Valid for ${days > 36_500n ? "more than 100 years" : `${days} days`}: once signed, anyone can execute it at any time until then, unless its nonce is used first.`;
}
