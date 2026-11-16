import { clearCache } from "@/.server/cache";
import { getEmergencyUpgrade } from "@/.server/flows/emergency";
import { getFreezeRequest } from "@/.server/flows/freeze";
import { getStandardUpgrade } from "@/.server/flows/standard";
import { UnsupportedHandlerError, governance } from "@/.server/governance";
import { simulate } from "@/.server/signatures";
import { safeAbi } from "@/common/abis";
import { emergencyExecution } from "@/common/execution";
import { upgradeProposalId } from "@/common/proposal";
import { safeMessageHashes } from "@/common/safe";
import { type ActionName, buildTypedData, governanceHashes } from "@/common/typed-data";
import {
  type Address,
  type Hex,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  pad,
  parseAbi,
  toHex,
  zeroAddress,
} from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_OWNER, ZIP19, signAsSafeOwner, startFork } from "../support/fork";
import { type MockSafe, startMockSafe } from "../support/mock-safe";

// Every write path, against the real deployed governance contracts and member Safes on a fork, with
// the handler as it is after ZIP-19 (the Guardians dissolved: the ZK Foundation's Safe approves and
// extends the legal veto itself, and the Emergency Upgrade Board takes two signers' groups). Nothing
// touches mainnet: the fork is local and Safe is a local mock.

let fork: Awaited<ReturnType<typeof startFork>>;
let safeApi: MockSafe;
let clean: Hex;
/** governance() on the fork before ZIP-19 is applied: the handler from before it. */
let beforeZip19: unknown;
const sender: Address = getAddress("0x00000000000000000000000000000000000c0ffe");
const LEGAL_VETO = 3 * 86_400;

beforeAll(async () => {
  fork = await startFork({ port: 18545 });
  safeApi = await startMockSafe({ port: 18546 });
  beforeZip19 = await governance().catch((error: unknown) => error);
  await fork.applyZip19();
  // A freeze touches every chain and bridge: their state is fetched once here, not under the
  // app's per-call time limit in the tests.
  const gov = await governance();
  await fork.prefetch(
    gov.securityCouncil.address,
    gov.upgradeHandler,
    encodeFunctionData({ abi: parseAbi(["function softFreeze()"]), functionName: "softFreeze" })
  );
  clearCache();
  clean = await fork.snapshot();
});

afterAll(async () => {
  await safeApi?.close();
  fork?.stop();
});

beforeEach(async () => {
  await fork.revert(clean);
  clean = await fork.snapshot();
  safeApi.reset();
  safeApi.failWith(null);
  clearCache();
});

/** Takes over `safes` on the fork and files TEST_OWNER's signatures in the mock Safe API. */
async function signInSafes(
  action: ActionName,
  domain: Parameters<typeof buildTypedData>[1],
  message: Record<string, string>,
  safes: Address[]
) {
  const typedData = buildTypedData(action, domain, message);
  const { digest } = governanceHashes(typedData);
  for (const safe of safes) {
    await fork.takeOver(safe);
    safeApi.add({
      safe,
      typedData,
      confirmations: [
        { owner: TEST_OWNER.address, signature: await signAsSafeOwner(safe, digest) },
      ],
    });
  }
  return { typedData, digest };
}

// Safe's SignMessageLib (v1.3.0 on mainnet): a Safe delegatecalls it to approve a message on-chain.
const SIGN_MESSAGE_LIB = getAddress("0xA65387F16B013cf2Af4605Ad8aA5ec25a2cbA3a2");
const safeTx = parseAbi([
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function signMessage(bytes _data)",
]);

/**
 * `safe` approves `digest` on-chain as a Safe does without Safe's API: its owners execute a
 * delegatecall to SignMessageLib (here TEST_OWNER, made its owner on the fork, sending it itself).
 */
async function approveOnChain(safe: Address, digest: Hex) {
  await fork.takeOver(safe);
  // The owner sends the Safe transaction itself: a pre-validated signature (r = owner, v = 1).
  const signature = concat([pad(TEST_OWNER.address), pad("0x00"), "0x01"]);
  const data = encodeFunctionData({ abi: safeTx, functionName: "signMessage", args: [digest] });
  const receipt = await fork.sendAs(
    TEST_OWNER.address,
    safe,
    encodeFunctionData({
      abi: safeTx,
      functionName: "execTransaction",
      args: [SIGN_MESSAGE_LIB, 0n, data, 1, 0n, 0n, 0n, zeroAddress, zeroAddress, signature],
    })
  );
  expect(receipt.status).toBe("success");
}

describe("on a mainnet fork, after ZIP-19", () => {
  it("reports the handler from before ZIP-19 as one this build does not show", () => {
    expect(beforeZip19).toBeInstanceOf(UnsupportedHandlerError);
    expect((beforeZip19 as Error).message).toMatch(/before ZIP-19/);
  });

  it("reads the Security Council, the ZK Foundation's Safe and the two-party board", async () => {
    const gov = await governance();
    expect(gov.zkFoundation).toBe(ZIP19.zkFoundation);
    expect(gov.emergencyUpgradeBoard.address).toBe(ZIP19.emergencyUpgradeBoard);
    expect(gov.emergencyUpgradeBoard.zkFoundation).toBe(ZIP19.zkFoundation);
    expect(gov.securityCouncil.members.length).toBeGreaterThan(0);
    expect(gov.warnings).toEqual([]);
  });

  it("approves ZIP-19's upgrade with the Security Council's Safe signatures", async () => {
    await fork.warp(LEGAL_VETO);
    clearCache();
    const gov = await governance();
    const before = await getStandardUpgrade(ZIP19.id);
    expect(before.state).toBe(2); // Waiting
    expect(before.sets.map((s) => s.key)).toEqual(["securityCouncil"]);
    await signInSafes(
      "ApproveUpgradeSecurityCouncil",
      gov.securityCouncil.domain,
      { id: ZIP19.id },
      gov.securityCouncil.members.slice(0, gov.securityCouncil.thresholds.approveUpgrade)
    );

    clearCache();
    const signed = await getStandardUpgrade(ZIP19.id);
    const council = signed.sets.find((s) => s.key === "securityCouncil");
    expect(council?.state.status).toBe("open");
    expect(council?.set.valid).toHaveLength(gov.securityCouncil.thresholds.approveUpgrade);
    expect(council?.execution?.simulation.status).toBe("ok");
    const receipt = await fork.sendAs(
      sender,
      council?.execution?.to as Address,
      council?.execution?.data as Hex
    );
    expect(receipt.status).toBe("success");

    clearCache();
    const after = await getStandardUpgrade(ZIP19.id);
    expect(after.state).toBe(3); // ExecutionPending
    const done = after.sets.find((s) => s.key === "securityCouncil");
    expect(done?.state).toMatchObject({ status: "done", txHash: receipt.transactionHash });
    expect(done?.used?.every((u) => u.matchesSafe)).toBe(true);
    expect(done?.historical?.accepted).toBe(true);
    // Approved by the Security Council: the ZK Foundation's approval is no longer possible.
    const approval = after.zkFoundation.steps.find((s) => s.key === "approval");
    expect(approval?.state.status).toBe("closed");
  });

  it("the ZK Foundation extends the legal veto from its Safe, and the page shows it done", async () => {
    const before = await getStandardUpgrade(ZIP19.id);
    expect(before.state).toBe(1); // LegalVetoPeriod
    expect(before.zkFoundation.safe).toBe(ZIP19.zkFoundation);
    const step = before.zkFoundation.steps.find((s) => s.key === "legalVeto");
    expect(step?.state.status).toBe("open");
    expect(step?.call).toMatchObject({ to: ZIP19.handler, functionName: "extendLegalVeto" });
    // Simulated from the Safe itself: the handler checks msg.sender.
    expect(step?.simulation?.status).toBe("ok");
    expect(await simulate(step?.call as NonNullable<typeof step>["call"])).toMatchObject({
      status: "reverted",
    });
    expect(before.zkFoundation.steps.find((s) => s.key === "approval")?.state.status).toBe(
      "closed"
    );

    const receipt = await fork.sendAs(
      ZIP19.zkFoundation,
      step?.call.to as Address,
      step?.call.data as Hex
    );
    expect(receipt.status).toBe("success");

    clearCache();
    const after = await getStandardUpgrade(ZIP19.id);
    expect(after.status.zkFoundationExtendedLegalVeto).toBe(true);
    expect(after.timeline.legalVetoEndsAt).toBe(ZIP19.createdAt + 7 * 86_400);
    const done = after.zkFoundation.steps.find((s) => s.key === "legalVeto");
    expect(done?.state).toMatchObject({ status: "done", txHash: receipt.transactionHash });
    expect(done?.simulation).toBeNull();
  });

  it("the ZK Foundation approves from its Safe once the legal veto ended", async () => {
    await fork.warp(LEGAL_VETO);
    clearCache();
    const before = await getStandardUpgrade(ZIP19.id);
    expect(before.state).toBe(2); // Waiting
    const step = before.zkFoundation.steps.find((s) => s.key === "approval");
    expect(step?.state.status).toBe("open");
    expect(step?.call).toMatchObject({
      to: ZIP19.handler,
      functionName: "approveUpgradeZkFoundation",
    });
    expect(step?.simulation?.status).toBe("ok");

    const receipt = await fork.sendAs(
      ZIP19.zkFoundation,
      step?.call.to as Address,
      step?.call.data as Hex
    );
    expect(receipt.status).toBe("success");

    clearCache();
    const after = await getStandardUpgrade(ZIP19.id);
    expect(after.status.zkFoundationApproval).toBe(true);
    // Ready a day after the 30-day waiting period that follows the legal veto.
    expect(after.timeline.readyAt).toBe(ZIP19.createdAt + LEGAL_VETO + 30 * 86_400 + 86_400);
    expect(after.zkFoundation.steps.find((s) => s.key === "approval")?.state).toMatchObject({
      status: "done",
      txHash: receipt.transactionHash,
    });
    // The Security Council can still approve (and make it ready sooner).
    expect(after.sets.find((s) => s.key === "securityCouncil")?.state.status).toBe("open");
  });

  it("collects a soft freeze in three member Safes and executes it", async () => {
    const gov = await governance();
    const validUntil = String(BigInt(gov.latestBlock.timestamp) + 7n * 86_400n);
    await signInSafes(
      "SoftFreeze",
      gov.securityCouncil.domain,
      { nonce: gov.securityCouncil.nonces.softFreeze, validUntil },
      gov.securityCouncil.members.slice(0, gov.securityCouncil.thresholds.softFreeze)
    );

    const nonce = gov.securityCouncil.nonces.softFreeze;
    const request = await getFreezeRequest({ action: "SoftFreeze", nonce, validUntil });
    expect(request.set.threshold).toBe(gov.securityCouncil.thresholds.softFreeze);
    expect(request.set.thresholdCheck.status).toBe("met");
    expect(request.execution?.simulation.status).toBe("ok");
    expect(
      (await fork.sendAs(sender, request.execution?.to as Address, request.execution?.data as Hex))
        .status
    ).toBe("success");

    clearCache();
    expect((await governance()).freeze.lastFreezeStatus).toBe(1); // Soft
    expect((await getFreezeRequest({ action: "SoftFreeze", nonce, validUntil })).state.status).toBe(
      "done"
    );
  });

  it("executes an emergency upgrade through the two-party board from a payload, then rebuilds it", async () => {
    const gov = await governance();
    const board = gov.emergencyUpgradeBoard;
    const proposal = {
      calls: [
        {
          target: getAddress("0x000000000000000000000000000000000000dEaD"),
          value: "0",
          data: "0x" as Hex,
        },
      ],
      executor: board.address,
      salt: keccak256(toHex("fork test")),
    };
    const id = upgradeProposalId(proposal);
    const council = gov.securityCouncil.members.slice(0, gov.securityCouncil.eip1271Threshold);
    await signInSafes("ExecuteEmergencyUpgradeSecurityCouncil", board.domain, { id }, council);
    await signInSafes("ExecuteEmergencyUpgradeZKFoundation", board.domain, { id }, [
      board.zkFoundation,
    ]);

    const pending = await getEmergencyUpgrade(id);
    expect(pending.state).toBe(0);
    expect(pending.roles.map((r) => r.key)).toEqual(["securityCouncil", "zkFoundation"]);
    expect(pending.roles.map((r) => r.set.thresholdCheck.status)).toEqual(["met", "met"]);
    const valid = (key: string) => pending.roles.find((r) => r.key === key)?.set.valid ?? [];
    const execution = emergencyExecution(
      board.address,
      proposal,
      valid("securityCouncil"),
      valid("zkFoundation")[0]?.signature as Hex
    );
    expect(await simulate(execution)).toEqual({ status: "ok" });
    expect((await fork.sendAs(sender, execution.to, execution.data)).status).toBe("success");

    clearCache();
    const executed = await getEmergencyUpgrade(id);
    expect(executed.state).toBe(6);
    expect(executed.executed?.idMatches).toBe(true);
    expect(executed.executed?.beforeZip19).toBe(false);
    expect(executed.executed?.proposal).toEqual(proposal);
    expect(executed.roles.every((r) => r.used?.every((u) => u.matchesSafe))).toBe(true);
    expect(executed.executed?.historical?.checks.map((c) => c.role)).toEqual([
      "Security Council",
      "ZKsync Foundation",
    ]);
    expect(executed.executed?.historical?.checks.every((c) => c.accepted)).toBe(true);
  });

  it("with Safe's API down, executes a soft freeze its member Safes approved on-chain", async () => {
    const gov = await governance();
    const validUntil = String(BigInt(gov.latestBlock.timestamp) + 7n * 86_400n);
    const message = { nonce: gov.securityCouncil.nonces.softFreeze, validUntil };
    const { digest } = governanceHashes(
      buildTypedData("SoftFreeze", gov.securityCouncil.domain, message)
    );
    const approvers = gov.securityCouncil.members.slice(
      0,
      gov.securityCouncil.thresholds.softFreeze
    );
    for (const safe of approvers) await approveOnChain(safe, digest);

    safeApi.failWith(503);
    clearCache();
    const request = await getFreezeRequest({ action: "SoftFreeze", ...message });
    expect(request.set.safeApiError).toMatch(/503/);
    expect(request.set.thresholdCheck.status).toBe("met");
    const valid = request.set.members.filter((m) => m.status === "valid");
    expect(valid.map((m) => m.member)).toEqual(expect.arrayContaining(approvers));
    expect(valid.every((m) => m.source === "onchain")).toBe(true);
    expect(request.execution?.simulation.status).toBe("ok");
    expect(
      (await fork.sendAs(sender, request.execution?.to as Address, request.execution?.data as Hex))
        .status
    ).toBe("success");
    clearCache();
    expect((await governance()).freeze.lastFreezeStatus).toBe(1); // Soft
  });

  it("with Safe's API down, executes an emergency upgrade both groups approved on-chain", async () => {
    const gov = await governance();
    const board = gov.emergencyUpgradeBoard;
    const proposal = {
      calls: [
        {
          target: getAddress("0x000000000000000000000000000000000000dEaD"),
          value: "0",
          data: "0x" as Hex,
        },
      ],
      executor: board.address,
      salt: keccak256(toHex("approved on-chain")),
    };
    const id = upgradeProposalId(proposal);
    const approve = async (action: ActionName, safes: Address[]) => {
      const { digest } = governanceHashes(buildTypedData(action, board.domain, { id }));
      for (const safe of safes) await approveOnChain(safe, digest);
    };
    await approve(
      "ExecuteEmergencyUpgradeSecurityCouncil",
      gov.securityCouncil.members.slice(0, gov.securityCouncil.eip1271Threshold)
    );
    await approve("ExecuteEmergencyUpgradeZKFoundation", [board.zkFoundation]);

    safeApi.failWith(503);
    clearCache();
    const pending = await getEmergencyUpgrade(id);
    expect(pending.roles.map((r) => r.set.thresholdCheck.status)).toEqual(["met", "met"]);
    for (const role of pending.roles) {
      expect(role.set.safeApiError).toMatch(/503/);
      const valid = role.set.members.filter((m) => m.status === "valid");
      expect(valid.length).toBeGreaterThan(0);
      expect(valid.every((m) => m.source === "onchain")).toBe(true);
    }
    // The execution carries an empty signature for each: the Safes accept their on-chain approval.
    const valid = (key: string) => pending.roles.find((r) => r.key === key)?.set.valid ?? [];
    const execution = emergencyExecution(
      board.address,
      proposal,
      valid("securityCouncil"),
      valid("zkFoundation")[0]?.signature as Hex
    );
    expect(await simulate(execution)).toEqual({ status: "ok" });
    expect((await fork.sendAs(sender, execution.to, execution.data)).status).toBe("success");
    clearCache();
    expect((await getEmergencyUpgrade(id)).state).toBe(6);
  });

  it("still counts on-chain approvals and supplied signatures when Safe's API is down", async () => {
    await fork.warp(LEGAL_VETO);
    clearCache();
    const gov = await governance();
    const [onchainMember, suppliedMember, strangerSafe] = gov.securityCouncil.members as [
      Address,
      Address,
      Address,
    ];
    const typedData = buildTypedData("ApproveUpgradeSecurityCouncil", gov.securityCouncil.domain, {
      id: ZIP19.id,
    });
    const { digest } = governanceHashes(typedData);
    // A Safe approving a message on-chain sets signedMessages[safeMessageHash] (storage slot 7 in v1.3.0).
    const hash = safeMessageHashes(1, onchainMember, digest).safeMessageHash;
    const slot = keccak256(
      encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [hash, 7n])
    );
    await fork.test.setStorageAt({ address: onchainMember, index: slot, value: pad("0x01") });
    expect(
      await fork.publicClient.readContract({
        address: onchainMember,
        abi: safeAbi,
        functionName: "signedMessages",
        args: [hash],
      })
    ).toBe(1n);
    await fork.takeOver(suppliedMember);

    safeApi.failWith(503);
    const detail = await getStandardUpgrade(ZIP19.id, {
      supplied: [
        { signer: suppliedMember, signature: await signAsSafeOwner(suppliedMember, digest) },
        // A Safe the test key does not own: the contract rejects it.
        { signer: strangerSafe, signature: await signAsSafeOwner(strangerSafe, digest) },
      ],
    });
    const council = detail.sets.find((s) => s.key === "securityCouncil")?.set;
    const byMember = (m: Address) => council?.members.find((x) => x.member === m);
    expect(byMember(onchainMember)).toMatchObject({ status: "valid", source: "onchain" });
    expect(byMember(suppliedMember)).toMatchObject({ status: "valid", source: "supplied" });
    // A link signature the contract rejects never sets the status: the member reads as without it
    // (Safe's API down: unavailable), and the rejection is said apart.
    expect(byMember(strangerSafe)).toMatchObject({
      status: "unavailable",
      source: null,
      rejectedFromLink: { error: expect.any(String) },
    });
    expect(council?.safeApiError).toMatch(/503/);
    expect(council?.members.filter((m) => m.status === "unavailable").length).toBeGreaterThan(0);
  });
});
