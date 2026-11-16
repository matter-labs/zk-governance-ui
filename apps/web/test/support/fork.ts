// Anvil fork of mainnet for write-path tests. Writes happen only on this local fork: member Safes
// get a well-known anvil test key as an extra owner (via impersonation), so tests can produce
// real Safe signatures that the real deployed contracts accept, on the fork only.
import { type ChildProcess, spawn } from "node:child_process";
import {
  type Address,
  type Hex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

// ZIP-19's L1 upgrade (Guardians dissolved), started at block 26,405,831 and in its legal veto period
// a few blocks later. Its contracts are deployed by then; applyZip19 makes the handler the one after
// ZIP-19 on the fork, leaving the upgrade itself in progress to approve.
export const ZIP19 = {
  id: "0xc334de7ae595405dd6a86ac80a33b0c60a956bd8eb815834167763d462f39933" as Hex,
  createdAt: 1_794_570_383,
  handler: "0xE30Dca3047B37dc7d88849dE4A4Dc07937ad5Ab3" as Address,
  proxyAdmin: "0x1e4c534e7ce1FF5621Ea506D99b367D7d8EFbE3e" as Address,
  implementation: "0xaD417a02cD56e535703404DEd7C8c5BaFE088DEE" as Address,
  zkFoundation: "0xbC1653bd3829dfEc575AfC3816D4899cd103B51c" as Address,
  emergencyUpgradeBoard: "0x3DBD9c38cc4A0D380fE9E32ACE0D2b147aD29FF1" as Address,
} as const;
export const FORK_BLOCK = 26_405_840n;

// anvil's first default dev key (public; never holds value).
export const TEST_OWNER = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
);

export async function startFork({
  port,
  forkUrl = process.env.FORK_URL || "https://mainnet.gateway.tenderly.co",
}: { port: number; forkUrl?: string }) {
  const child: ChildProcess = spawn(
    "anvil",
    [
      "--fork-url",
      forkUrl,
      "--fork-block-number",
      FORK_BLOCK.toString(),
      "--port",
      String(port),
      "--silent",
    ],
    { stdio: "ignore" }
  );
  const url = `http://127.0.0.1:${port}`;
  const publicClient = createPublicClient({ chain: mainnet, transport: http(url) });
  for (let i = 0; ; i++) {
    try {
      await publicClient.getBlockNumber();
      break;
    } catch {
      if (i > 120) throw new Error("anvil did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return {
    url,
    stop: () => child.kill(),
    ...forkActions(url),
  };
}

const safeAdmin = parseAbi(["function addOwnerWithThreshold(address owner, uint256 _threshold)"]);
const zip19Calls = parseAbi([
  "function upgradeAndCall(address proxy, address implementation, bytes data) payable",
  "function updateZkFoundation(address _newZkFoundation)",
  "function updateEmergencyUpgradeBoard(address _newEmergencyUpgradeBoard)",
]);

export function forkActions(url: string) {
  const test = createTestClient({ chain: mainnet, mode: "anvil", transport: http(url) });
  const publicClient = createPublicClient({ chain: mainnet, transport: http(url) });

  /** Sends a transaction as `from` (impersonated) and waits for it. */
  async function sendAs(from: Address, to: Address, data: Hex, value = 0n) {
    await test.setBalance({ address: from, value: parseEther("100") + value });
    await test.impersonateAccount({ address: from });
    const wallet = createWalletClient({ chain: mainnet, transport: http(url), account: from });
    const hash = await wallet.sendTransaction({ to, data, value });
    await test.stopImpersonatingAccount({ address: from });
    return publicClient.waitForTransactionReceipt({ hash });
  }

  return {
    publicClient,
    test,
    sendAs,
    snapshot: () => test.snapshot(),
    revert: (id: Hex) => test.revert({ id }),
    /**
     * ZIP-19's calls as the handler makes them when the upgrade executes (its first call only reads
     * the roles): the implementation without Guardians, the ZK Foundation's Safe in their role, the
     * two-party Emergency Upgrade Board. The upgrade 0xc334… itself stays in progress.
     */
    async applyZip19() {
      const calls: [Address, Hex][] = [
        [
          ZIP19.proxyAdmin,
          encodeFunctionData({
            abi: zip19Calls,
            functionName: "upgradeAndCall",
            args: [ZIP19.handler, ZIP19.implementation, "0x"],
          }),
        ],
        [
          ZIP19.handler,
          encodeFunctionData({
            abi: zip19Calls,
            functionName: "updateZkFoundation",
            args: [ZIP19.zkFoundation],
          }),
        ],
        [
          ZIP19.handler,
          encodeFunctionData({
            abi: zip19Calls,
            functionName: "updateEmergencyUpgradeBoard",
            args: [ZIP19.emergencyUpgradeBoard],
          }),
        ],
      ];
      for (const [to, data] of calls) {
        const receipt = await sendAs(ZIP19.handler, to, data);
        if (receipt.status !== "success") throw new Error(`ZIP-19 call to ${to} failed`);
      }
    },
    /**
     * Runs a call once (an eth_call, nothing sent) with no time limit, so the fork fetches the
     * remote state it touches before a test's reads, which the app gives 10 s each.
     */
    async prefetch(from: Address, to: Address, data: Hex) {
      const patient = createPublicClient({
        chain: mainnet,
        transport: http(url, { timeout: 600_000 }),
      });
      await patient.call({ account: from, to, data }).catch(() => {});
    },
    /** Moves the fork's clock on by `seconds` and mines a block there. */
    async warp(seconds: number) {
      await test.increaseTime({ seconds });
      await test.mine({ blocks: 1 });
    },
    /** Makes TEST_OWNER a 1-of-n signer of `safe` on the fork (the Safe calls itself). */
    async takeOver(safe: Address) {
      const receipt = await sendAs(
        safe,
        safe,
        encodeFunctionData({
          abi: safeAdmin,
          functionName: "addOwnerWithThreshold",
          args: [TEST_OWNER.address, 1n],
        })
      );
      if (receipt.status !== "success") throw new Error(`takeover of ${safe} failed`);
    },
  };
}

/** TEST_OWNER's signature over `safe`'s SafeMessage for a governance digest. */
export function signAsSafeOwner(safe: Address, digest: Hex, chainId = 1) {
  return TEST_OWNER.signTypedData({
    domain: { chainId, verifyingContract: safe },
    types: { SafeMessage: [{ name: "message", type: "bytes" }] },
    primaryType: "SafeMessage",
    message: { message: digest },
  });
}
