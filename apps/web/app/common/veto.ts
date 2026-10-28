// A Guardians veto is fully described by the values it signs, so its page URL carries all of them.
export type VetoQuery = {
  l2ProposalId: string;
  l2GovernorAddress: string;
  l2GasLimit: string;
  l2GasPerPubdataByteLimit: string;
  refundRecipient: string;
  txMintValue: string;
  nonce: string;
};

export function vetoPath(v: VetoQuery) {
  const query = new URLSearchParams({
    governor: v.l2GovernorAddress,
    l2GasLimit: v.l2GasLimit,
    l2GasPerPubdataByteLimit: v.l2GasPerPubdataByteLimit,
    refundRecipient: v.refundRecipient,
    txMintValue: v.txMintValue,
    nonce: v.nonce,
  });
  return `/app/l2-cancellations/${v.l2ProposalId}?${query}`;
}

// Defaults matching the veto Guardians executed on mainnet (nonce 0).
export const VETO_DEFAULTS = {
  l2GasLimit: "30000000",
  l2GasPerPubdataByteLimit: "800",
  txMintValue: "20000000000000000",
};

const MAX_PLAUSIBLE_L2_GAS = 80_000_000n;
const MAX_PLAUSIBLE_MINT = 10n ** 18n;
const ZERO = /^0x0{40}$/i;

/**
 * What is odd in a veto's link values, said before anyone signs them: they are all signed, and a
 * link can carry anything. Empty when nothing is.
 */
export function vetoValueWarnings(
  v: Pick<VetoQuery, "l2GasLimit" | "l2GasPerPubdataByteLimit" | "refundRecipient" | "txMintValue">
): string[] {
  const warnings: string[] = [];
  const big = (value: string) => {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  };
  const gas = big(v.l2GasLimit);
  if (gas !== null && gas > MAX_PLAUSIBLE_L2_GAS)
    warnings.push(
      `L2 gas limit ${v.l2GasLimit} is far above what one L1 → L2 transaction can use (the default is ${VETO_DEFAULTS.l2GasLimit}).`
    );
  if (v.l2GasPerPubdataByteLimit !== VETO_DEFAULTS.l2GasPerPubdataByteLimit)
    warnings.push(
      `Gas per pubdata byte is ${v.l2GasPerPubdataByteLimit}: ZKsync Era accepts only ${VETO_DEFAULTS.l2GasPerPubdataByteLimit}, so the veto would revert.`
    );
  const mint = big(v.txMintValue);
  if (mint === 0n) warnings.push("The mint value is 0: it cannot pay for the L1 → L2 transaction.");
  else if (mint !== null && mint > MAX_PLAUSIBLE_MINT)
    warnings.push(
      `The mint value is more than 1 ETH (${v.txMintValue} wei), sent with the L1 transaction.`
    );
  if (ZERO.test(v.refundRecipient))
    warnings.push("The refund recipient is the zero address: whatever is not spent on L2 is lost.");
  return warnings;
}
