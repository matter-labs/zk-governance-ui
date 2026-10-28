import { freezeActionFromSlug } from "@/common/freeze";
import { badRequest, notFound } from "@/utils/http";
import { type Hex, getAddress, isAddress } from "viem";
import type { FreezeParams } from "./flows/freeze";
import type { VetoParams } from "./flows/l2-veto";
import { bytes32Pattern } from "./request";

// URL → flow parameters, shared by the pages and the JSON API so both run the same checks.

const uint = /^\d{1,78}$/;
const MAX_UINT256 = (1n << 256n) - 1n;

/** 78 digits can still exceed a uint256: such a value could never be signed or encoded. */
function requireUint256(values: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && BigInt(value) > MAX_UINT256)
      throw badRequest(`${name} is above 2^256 − 1, the largest uint256: no request can carry it.`);
  }
}

export function parseId(raw: string | undefined): Hex {
  if (!raw || !bytes32Pattern.test(raw)) throw notFound();
  return raw.toLowerCase() as Hex;
}

export function parseFreezeParams(slug: string | undefined, url: URL): FreezeParams {
  const action = freezeActionFromSlug(slug ?? "");
  const nonce = url.searchParams.get("nonce") ?? "";
  const validUntil = url.searchParams.get("validUntil") ?? "";
  const threshold = url.searchParams.get("threshold") ?? undefined;
  if (!action || !uint.test(nonce) || !uint.test(validUntil)) throw notFound();
  if (action === "SetSoftFreezeThreshold" && !uint.test(threshold ?? "")) throw notFound();
  requireUint256({
    nonce,
    validUntil,
    threshold: action === "SetSoftFreezeThreshold" ? threshold : undefined,
  });
  return {
    action,
    nonce,
    validUntil,
    threshold: action === "SetSoftFreezeThreshold" ? threshold : undefined,
  };
}

export function parseVetoParams(id: string | undefined, url: URL): VetoParams {
  const q = url.searchParams;
  const field = (name: string) => q.get(name) ?? "";
  const governor = field("governor");
  const refund = field("refundRecipient");
  const values = {
    l2ProposalId: id ?? "",
    l2GasLimit: field("l2GasLimit"),
    l2GasPerPubdataByteLimit: field("l2GasPerPubdataByteLimit"),
    txMintValue: field("txMintValue"),
    nonce: field("nonce"),
  };
  if (
    !Object.values(values).every((v) => uint.test(v)) ||
    !isAddress(governor) ||
    !isAddress(refund)
  )
    throw notFound();
  requireUint256(values);
  return {
    ...values,
    l2GovernorAddress: getAddress(governor),
    refundRecipient: getAddress(refund),
  };
}
