import { clearCache } from "@/.server/cache";
import { getEmergencyUpgrade } from "@/.server/flows/emergency";
import { getFreezeRequest } from "@/.server/flows/freeze";
import { getL2Veto } from "@/.server/flows/l2-veto";
import { getStandardUpgrade } from "@/.server/flows/standard";
import { governance } from "@/.server/governance";
import { simulate } from "@/.server/signatures";
import { guardiansAbi, safeAbi } from "@/common/abis";
import { cancelL2Execution, emergencyExecution } from "@/common/execution";
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
import { UPGRADE_ID } from "../support/fixtures";
import { TEST_OWNER, signAsSafeOwner, startFork } from "../support/fork";
import { type MockSafe, startMockSafe } from "../support/mock-safe";

// Every write path, against the real deployed governance contracts and member Safes on a fork.
// Nothing touches mainnet: the fork is local and Safe is a local mock.

let fork: Awaited<ReturnType<typeof startFork>>;
let safeApi: MockSafe;
let clean: Hex;
const sender: Address = getAddress("0x00000000000000000000000000000000000c0ffe");

beforeAll(async () => {
  fork = await startFork({ port: 18545 });
  safeApi = await startMockSafe({ port: 18546 });
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

describe("on a mainnet fork", () => {
  it("approves upgrade 0x77d5… with the Security Council's real Safe signatures", async () => {
    const before = await getStandardUpgrade(UPGRADE_ID);
    expect(before.state).toBe(2); // Waiting
    const council = before.sets.find((s) => s.key === "securityCouncil");
    expect(council?.state.status).toBe("open");
    expect(council?.set.valid).toHaveLength(7);
    expect(council?.execution?.simulation.status).toBe("ok");

    const receipt = await fork.sendAs(
      sender,
      council?.execution?.to as Address,
      council?.execution?.data as Hex
    );
    expect(receipt.status).toBe("success");

    clearCache();
    const after = await getStandardUpgrade(UPGRADE_ID);
    expect(after.state).toBe(3); // ExecutionPending
    const done = after.sets.find((s) => s.key === "securityCouncil");
    expect(done?.state).toMatchObject({ status: "done", txHash: receipt.transactionHash });
    expect(done?.used?.every((u) => u.matchesSafe)).toBe(true);
    expect(done?.historical?.accepted).toBe(true);
  });

  it("collects a soft freeze in three member Safes and executes it", async () => {
    const gov = await governance();
    const validUntil = String(BigInt(gov.latestBlock.timestamp) + 7n * 86_400n);
    await signInSafes(
      "SoftFreeze",
      gov.securityCouncil.domain,
      { nonce: "0", validUntil },
      gov.securityCouncil.members.slice(0, 3)
    );

    const request = await getFreezeRequest({ action: "SoftFreeze", nonce: "0", validUntil });
    expect(request.set.threshold).toBe(gov.securityCouncil.thresholds.softFreeze);
    expect(request.set.thresholdCheck.status).toBe("met");
    expect(request.execution?.simulation.status).toBe("ok");
    expect(
      (await fork.sendAs(sender, request.execution?.to as Address, request.execution?.data as Hex))
        .status
    ).toBe("success");

    clearCache();
    expect((await governance()).freeze.lastFreezeStatus).toBe(1); // Soft
    expect(
      (await getFreezeRequest({ action: "SoftFreeze", nonce: "0", validUntil })).state.status
    ).toBe("done");
  });

  it("executes an emergency upgrade from a payload, then rebuilds that payload from the execution", async () => {
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
    const guardians = gov.guardians.members.slice(0, gov.guardians.eip1271Threshold);
    await signInSafes("ExecuteEmergencyUpgradeSecurityCouncil", board.domain, { id }, council);
    await signInSafes("ExecuteEmergencyUpgradeGuardians", board.domain, { id }, guardians);
    await signInSafes("ExecuteEmergencyUpgradeZKFoundation", board.domain, { id }, [
      board.zkFoundation,
    ]);

    const pending = await getEmergencyUpgrade(id);
    expect(pending.state).toBe(0);
    expect(pending.roles.map((r) => r.set.thresholdCheck.status)).toEqual(["met", "met", "met"]);
    const valid = (key: string) => pending.roles.find((r) => r.key === key)?.set.valid ?? [];
    const execution = emergencyExecution(
      board.address,
      proposal,
      valid("guardians"),
      valid("securityCouncil"),
      valid("zkFoundation")[0]?.signature as Hex
    );
    expect(await simulate(execution)).toEqual({ status: "ok" });
    expect((await fork.sendAs(sender, execution.to, execution.data)).status).toBe("success");

    clearCache();
    const executed = await getEmergencyUpgrade(id);
    expect(executed.state).toBe(6);
    expect(executed.executed?.idMatches).toBe(true);
    expect(executed.executed?.proposal).toEqual(proposal);
    expect(executed.roles.every((r) => r.used?.every((u) => u.matchesSafe))).toBe(true);
    expect(executed.executed?.historical?.checks.every((c) => c.accepted)).toBe(true);
  });

  it("verifies a Guardian veto and sends it to ZKsync Era from L1", async () => {
    const gov = await governance();
    const params = {
      l2ProposalId: "62921954496791164991088292844527972033503604235062526266434445973055965160650",
      l2GovernorAddress: getAddress("0xb83FF6501214ddF40C91C9565d095400f3F45746"),
      l2GasLimit: "30000000",
      l2GasPerPubdataByteLimit: "800",
      refundRecipient: sender,
      txMintValue: "20000000000000000",
      nonce: gov.guardians.nonce,
    };
    await signInSafes(
      "CancelL2GovernorProposal",
      gov.guardians.domain,
      params,
      gov.guardians.members.slice(0, gov.guardians.thresholds.cancelL2Proposal)
    );

    const veto = await getL2Veto(params);
    expect(veto.set.thresholdCheck.status).toBe("met");
    expect(veto.l2Proposal?.idMatchesLocal).toBe(true);
    // This rehearsal proposal is already cancelled on L2, so the app does not offer to send it…
    expect(veto.state).toMatchObject({ status: "closed" });
    // …but the L1 side the app builds is accepted by Guardians.
    const execution = cancelL2Execution(
      gov.guardians.address,
      veto.l2Proposal as NonNullable<typeof veto.l2Proposal>,
      {
        to: params.l2GovernorAddress,
        l2GasLimit: params.l2GasLimit,
        l2GasPerPubdataByteLimit: params.l2GasPerPubdataByteLimit,
        refundRecipient: params.refundRecipient,
        txMintValue: params.txMintValue,
      },
      veto.set.valid
    );
    expect(
      (await fork.sendAs(sender, execution.to, execution.data, BigInt(execution.value))).status
    ).toBe("success");
    const nonce = await fork.publicClient.readContract({
      address: gov.guardians.address,
      abi: guardiansAbi,
      functionName: "nonce",
    });
    expect(nonce).toBe(BigInt(params.nonce) + 1n);
  });

  it("with Safe's API down, executes a soft freeze its member Safes approved on-chain", async () => {
    const gov = await governance();
    const validUntil = String(BigInt(gov.latestBlock.timestamp) + 7n * 86_400n);
    const message = { nonce: "0", validUntil };
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

  it("with Safe's API down, executes an emergency upgrade every group approved on-chain", async () => {
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
    await approve(
      "ExecuteEmergencyUpgradeGuardians",
      gov.guardians.members.slice(0, gov.guardians.eip1271Threshold)
    );
    await approve("ExecuteEmergencyUpgradeZKFoundation", [board.zkFoundation]);

    safeApi.failWith(503);
    clearCache();
    const pending = await getEmergencyUpgrade(id);
    expect(pending.roles.map((r) => r.set.thresholdCheck.status)).toEqual(["met", "met", "met"]);
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
      valid("guardians"),
      valid("securityCouncil"),
      valid("zkFoundation")[0]?.signature as Hex
    );
    expect(await simulate(execution)).toEqual({ status: "ok" });
    expect((await fork.sendAs(sender, execution.to, execution.data)).status).toBe("success");
    clearCache();
    expect((await getEmergencyUpgrade(id)).state).toBe(6);
  });

  it("still counts on-chain approvals and supplied signatures when Safe's API is down", async () => {
    const gov = await governance();
    const [onchainMember, suppliedMember, strangerSafe] = gov.securityCouncil.members as [
      Address,
      Address,
      Address,
    ];
    const typedData = buildTypedData("ApproveUpgradeSecurityCouncil", gov.securityCouncil.domain, {
      id: UPGRADE_ID,
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
    const detail = await getStandardUpgrade(UPGRADE_ID, {
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
