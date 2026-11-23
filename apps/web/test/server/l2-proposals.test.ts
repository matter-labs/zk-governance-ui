import { clearCache } from "@/.server/cache";
import { l2GovernorAbi } from "@/common/abis";
import {
  type Address,
  type Hex,
  InternalRpcError,
  type PublicClient,
  RpcRequestError,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  keccak256,
  toHex,
} from "viem";
import { beforeEach, expect, it, vi } from "vitest";

// An L2 proposal of the protocol governor, scanned on demand: a proposal whose state() read fails
// must not be shown without a state (null is only a value outside IGovernor.ProposalState); the
// read fails instead.

const PROTOCOL_GOVERNOR: Address = "0x0000000000000000000000000000000000000a01";

const proposal = {
  targets: ["0x0000000000000000000000000000000000000b01"] as Address[],
  values: [0n],
  calldatas: ["0x1234"] as Hex[],
  description: "Raise the limit",
};
const proposalId = BigInt(
  keccak256(
    encodeAbiParameters(
      [{ type: "address[]" }, { type: "uint256[]" }, { type: "bytes[]" }, { type: "bytes32" }],
      [
        proposal.targets,
        proposal.values,
        proposal.calldatas,
        keccak256(toHex(proposal.description)),
      ]
    )
  )
);

const state = vi.hoisted(() => ({
  // What Governor.state(id) answers: a ProposalState number, or an error to throw.
  l2State: 1 as number | Error,
}));

const created = getAbiItem({ abi: l2GovernorAbi, name: "ProposalCreated" });
const log = {
  address: "0x0000000000000000000000000000000000000a01",
  topics: encodeEventTopics({ abi: l2GovernorAbi, eventName: "ProposalCreated" }),
  data: encodeAbiParameters(created.inputs, [
    proposalId,
    "0x0000000000000000000000000000000000000c01",
    proposal.targets,
    proposal.values,
    [""],
    proposal.calldatas,
    100n,
    200n,
    proposal.description,
  ]),
  transactionHash: `0x${"ab".repeat(32)}`,
};

vi.mock("@/.server/logs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/.server/logs")>()),
  findBlockByTimestamp: async () => 1n,
  getLogs: async (_client: unknown, filter: { address: string }) =>
    filter.address === PROTOCOL_GOVERNOR ? [log] : [],
}));

const client = {
  getBlock: async () => ({ number: 1_000n, timestamp: 10_000_000n }),
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === "proposalSnapshot") return 100n;
    if (functionName === "votingDelay") return 0n;
    if (functionName !== "state") throw new Error(`unexpected ${functionName}`);
    if (state.l2State instanceof Error) throw state.l2State;
    return state.l2State;
  },
} as unknown as PublicClient;

vi.mock("@/.server/rpc", () => ({
  // No Era RPC URL of its own: the governor is not indexed, so it is scanned on demand.
  network: async () => ({
    chainId: 1,
    isDevNode: false,
    l2Governors: { protocol: PROTOCOL_GOVERNOR },
  }),
  l2: async () => client,
}));

const { getL2Proposal } = await import("@/.server/flows/l2");

beforeEach(() => {
  clearCache();
  state.l2State = 1;
});

it("reads an Active proposal with its checked id", async () => {
  expect(await getL2Proposal(PROTOCOL_GOVERNOR, proposalId)).toMatchObject({
    governorName: "ZkProtocolGovernor",
    proposalId: proposalId.toString(),
    state: "Active",
    idMatchesLocal: true,
  });
});

it.each([
  [
    "an internal error (-32603)",
    () =>
      new InternalRpcError(
        new RpcRequestError({
          body: {},
          error: { code: -32603, message: "internal error" },
          url: "http://l2",
        })
      ),
  ],
  ["a network failure", () => new Error("fetch failed")],
])("fails the read when the state read fails with %s", async (_name, error) => {
  state.l2State = error();
  await expect(getL2Proposal(PROTOCOL_GOVERNOR, proposalId)).rejects.toThrow();
});
