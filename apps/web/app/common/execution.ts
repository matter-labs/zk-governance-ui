import { type Address, type Hex, encodeAbiParameters, encodeFunctionData, hexToBigInt } from "viem";
import { emergencyUpgradeBoardAbi, securityCouncilAbi, upgradeHandlerAbi } from "./abis";
import type { UpgradeProposal } from "./proposal";

// Calldata for the transactions that consume signatures. Anyone can send these: the contracts
// check the signatures, not the sender. The one exception, zkFoundationCall, is the call only the
// ZK Foundation's Safe can make (the handler checks msg.sender): its owners sign it as a Safe
// transaction in their Safe.

export type MemberSignature = { signer: Address; signature: Hex };

export type Execution = {
  to: Address;
  data: Hex;
  // wei, decimal string
  value: string;
  functionName: string;
};

/** Multisig.checkSignatures walks the sorted member list, so signers must be in ascending order. */
export function sortBySigner<T extends MemberSignature>(signatures: T[]): T[] {
  return [...signatures].sort((a, b) => {
    const x = hexToBigInt(a.signer);
    const y = hexToBigInt(b.signer);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

const split = (signatures: MemberSignature[]) => {
  const sorted = sortBySigner(signatures);
  return [sorted.map((s) => s.signer), sorted.map((s) => s.signature)] as const;
};

export function approvalExecution(
  contract: Address,
  id: Hex,
  signatures: MemberSignature[]
): Execution {
  const [signers, sigs] = split(signatures);
  return {
    to: contract,
    value: "0",
    functionName: "approveUpgradeSecurityCouncil",
    data: encodeFunctionData({
      abi: securityCouncilAbi,
      functionName: "approveUpgradeSecurityCouncil",
      args: [id, signers, sigs],
    }),
  };
}

export type ZkFoundationAction = "approveUpgradeZkFoundation" | "extendLegalVeto";

/** What the ZK Foundation Safe calls on the handler (its own Safe transaction): no signatures. */
export function zkFoundationCall(
  upgradeHandler: Address,
  functionName: ZkFoundationAction,
  id: Hex
): Execution {
  return {
    to: upgradeHandler,
    value: "0",
    functionName,
    data: encodeFunctionData({ abi: upgradeHandlerAbi, functionName, args: [id] }),
  };
}

export type FreezeAction = "SoftFreeze" | "HardFreeze" | "Unfreeze" | "SetSoftFreezeThreshold";

// The nonce is not an argument: the contract signs over its current nonce and increments it.
export function freezeExecution(
  action: FreezeAction,
  securityCouncil: Address,
  message: { validUntil: string; threshold?: string },
  signatures: MemberSignature[]
): Execution {
  const [signers, sigs] = split(signatures);
  const validUntil = BigInt(message.validUntil);
  if (action === "SetSoftFreezeThreshold") {
    return {
      to: securityCouncil,
      value: "0",
      functionName: "setSoftFreezeThreshold",
      data: encodeFunctionData({
        abi: securityCouncilAbi,
        functionName: "setSoftFreezeThreshold",
        args: [BigInt(message.threshold ?? "0"), validUntil, signers, sigs],
      }),
    };
  }
  const functionName = (
    { SoftFreeze: "softFreeze", HardFreeze: "hardFreeze", Unfreeze: "unfreeze" } as const
  )[action];
  return {
    to: securityCouncil,
    value: "0",
    functionName,
    data: encodeFunctionData({
      abi: securityCouncilAbi,
      functionName,
      args: [validUntil, signers, sigs],
    }),
  };
}

export type L2Proposal = {
  targets: Address[];
  values: string[];
  calldatas: Hex[];
  description: string;
};

/** abi.encode(address[] signers, bytes[] signatures): the EIP-1271 blob SecurityCouncil accepts. */
export function encodeMultisigSignature(signatures: MemberSignature[]): Hex {
  const [signers, sigs] = split(signatures);
  return encodeAbiParameters([{ type: "address[]" }, { type: "bytes[]" }], [signers, sigs]);
}

export function emergencyExecution(
  board: Address,
  proposal: Pick<UpgradeProposal, "calls" | "salt">,
  securityCouncil: MemberSignature[],
  zkFoundationSignature: Hex
): Execution {
  return {
    to: board,
    value: "0",
    functionName: "executeEmergencyUpgrade",
    data: encodeFunctionData({
      abi: emergencyUpgradeBoardAbi,
      functionName: "executeEmergencyUpgrade",
      args: [
        proposal.calls.map((c) => ({ target: c.target, value: BigInt(c.value), data: c.data })),
        proposal.salt,
        encodeMultisigSignature(securityCouncil),
        zkFoundationSignature,
      ],
    }),
  };
}

export function executeUpgradeExecution(
  upgradeHandler: Address,
  proposal: UpgradeProposal
): Execution {
  return {
    to: upgradeHandler,
    value: "0",
    functionName: "execute",
    data: encodeFunctionData({
      abi: upgradeHandlerAbi,
      functionName: "execute",
      args: [
        {
          calls: proposal.calls.map((c) => ({
            target: c.target,
            value: BigInt(c.value),
            data: c.data,
          })),
          executor: proposal.executor,
          salt: proposal.salt,
        },
      ],
    }),
  };
}
