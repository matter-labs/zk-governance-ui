import type { Lane } from "@/.server/chain/jsonrpc";
import { type Address, getAddress } from "viem";
import { beforeEach, expect, it, vi } from "vitest";
import { fakeCallLane, internalError, outOfGas, revertWith } from "../support/fake-calls";
import { FakeRpcError } from "../support/fake-jsonrpc";

// The proposer's draft check on /app/emergency/new: each call as an eth_call from the
// ProtocolUpgradeHandler. "reverts" only on the node's definite revert; an RPC failure is "could
// not check", never a revert.

const PUH = getAddress("0xE30Dca3047B37dc7d88849dE4A4Dc07937ad5Ab3");
const TARGET: Address = "0x000000000000000000000000000000000000dEaD";

const state = vi.hoisted(() => ({
  lane: null as Lane | null,
  noHead: false,
  // eth_getCode's answer for an address ("0x": no contract), or an error for it.
  code: (_address: string): unknown => "0x6080",
}));
vi.mock("@/.server/rpc", () => ({
  lanes: () => ({ call: state.lane }),
  network: async () => ({ chainId: 1, isDevNode: false }),
  latestBlock: async () => {
    if (state.noHead) throw new Error("head unavailable");
    return { number: 1234n, hash: `0x${"ab".repeat(32)}`, timestamp: 1n };
  },
}));
vi.mock("@/.server/governance", () => ({
  governance: async () => ({ upgradeHandler: PUH }),
}));

const { checkDraftCalls, NO_CONTRACT } = await import("@/.server/flows/emergency-draft");
const { clearCache } = await import("@/.server/cache");

let reply: (index: number) => unknown;
let calls: ReturnType<typeof fakeCallLane>["calls"];

beforeEach(() => {
  clearCache();
  state.noHead = false;
  state.code = () => "0x6080";
  reply = () => "0x";
  const fake = fakeCallLane((call) => {
    if (call.method === "eth_getCode") return state.code(call.params[0] as string);
    const tx = call.params[0] as { data: string };
    return reply(Number.parseInt(tx.data.slice(2) || "0", 16));
  });
  state.lane = fake.lane;
  calls = fake.calls;
});

const draft = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    target: TARGET,
    value: BigInt(i),
    data: `0x0${i}` as const,
  }));

it("sends each call from the ProtocolUpgradeHandler with its value, all at the head, named", async () => {
  expect(await checkDraftCalls(draft(2))).toEqual({
    results: [{ ok: true }, { ok: true }],
    atBlock: "1234",
  });
  expect(calls().map((c) => c.params)).toEqual([
    [{ to: TARGET, data: "0x00", from: PUH, value: "0x0" }, "0x4d2"],
    [{ to: TARGET, data: "0x01", from: PUH, value: "0x1" }, "0x4d2"],
  ]);
});

it("checks at 'latest' when the head cannot be read, naming no block", async () => {
  state.noHead = true;
  expect(await checkDraftCalls(draft(1))).toEqual({ results: [{ ok: true }], atBlock: null });
  expect(calls().map((c) => c.params[1])).toEqual(["latest"]);
});

it("reports a revert only for a definite revert, and an RPC failure as unchecked", async () => {
  const answers = [
    revertWith("Ownable: caller is not the owner"),
    new FakeRpcError(-32000, "execution reverted"),
    internalError(),
    outOfGas(),
    new FakeRpcError(-32005, "request rate exceeded"),
  ];
  reply = (index) => answers[index];
  const { results } = await checkDraftCalls(draft(answers.length));
  expect(results.slice(0, 2)).toEqual([
    { ok: false, error: "Ownable: caller is not the owner" },
    { ok: false, error: "execution reverted" },
  ]);
  for (const result of results.slice(2)) {
    expect(result).toMatchObject({ ok: null, skipped: expect.stringMatching(/^RPC error: /) });
  }
});

it("reports an HTTP failure as unchecked, never as a revert", async () => {
  const fake = fakeCallLane(() => "0x", {
    intercept: () => new Response("Too Many Requests", { status: 429 }),
  });
  state.lane = fake.lane;
  const {
    results: [result],
  } = await checkDraftCalls(draft(1));
  expect(result).toMatchObject({ ok: null });
});

it("says a call to an address without code runs nothing, never that it succeeds", async () => {
  state.code = () => "0x";
  const { results } = await checkDraftCalls([
    { target: TARGET, value: 0n, data: "0xdeadbeef" },
    { target: TARGET, value: 0n, data: "0x" },
    // A plain transfer to an account: nothing to run, and nothing wrong.
    { target: TARGET, value: 1n, data: "0x" },
  ]);
  expect(results).toEqual([
    { ok: null, skipped: NO_CONTRACT },
    { ok: null, skipped: NO_CONTRACT },
    { ok: true },
  ]);
});

it("reports a failed code read as unchecked, never as a success", async () => {
  state.code = () => internalError();
  const {
    results: [result],
  } = await checkDraftCalls(draft(1));
  expect(result).toMatchObject({ ok: null, skipped: expect.stringMatching(/^RPC error: /) });
});
