import { type Address, type Hex, toEventSelector } from "viem";

// Trust anchors pinned per chain. Everything else (Security Council, ZK Foundation, Emergency
// Upgrade Board, members, thresholds, nonces) is read from the ProtocolUpgradeHandler on every load,
// so a change of council is picked up without a release.
//
// Sources, checked 2026-10-01 against the chain itself:
// - Mainnet ProtocolUpgradeHandler: zksync-association brief; its ChangeSecurityCouncil(0x0 → …)
//   event at block 21788382 marks the deployment and doubles as the log-history canary.
// - L2 protocol governor: docs.zknation.io "ZKsync Governance Contract Addresses", cross-checked
//   on-chain: ZkProtocolGovernor.timelock() == ProtocolUpgradeHandler.L2_PROTOCOL_GOVERNOR. The
//   Token and GovOps governors are not read: their veto belongs to the ZK Foundation's own Safe on
//   ZKsync Era since TPP-20 and GAP-7 (ZIP-19 dissolved the Guardians), a Safe transaction on Era.
// - L2 governor log blocks (eth_getLogs over the protocol governor from Era genesis, 2026-11-16):
//   its first ProposalCreated/Executed/Canceled log, and its first log of any kind (deployment).
// - Sepolia ProtocolUpgradeHandler 0x7444…: apps/web/docs (removed). The one listed in the docs
//   (0xe3a6…) is a proxy whose implementation no longer has handler functions. Other Sepolia
//   handlers answer the handler ABI too (testnet's 0x803e5E7aF1FDD504F8844E28a249203Cfa7c471D,
//   stage's 0x8f08627524aeD610192132A425D6b9C32a1727EF). Override with UPGRADE_HANDLER_ADDRESS.
export type NetworkName = "mainnet" | "sepolia" | "local";

// keccak256 of runtime code the app relies on (read on mainnet at block 26,141,196). Only while it
// matches is what that code never writes after its constructor kept per process, and the verdict
// fast path used (the ZK Foundation Safe's: while its singleton and fallback handler match too).
export type CodePins = {
  securityCouncil: Hex;
  emergencyUpgradeBoard: Hex;
  /** Safe 1.3.0 proxy runtime code (every member Safe's and the ZK Foundation's). */
  safeProxy: Hex;
  /** Safe 1.3.0 singleton (slot 0 of the proxy) and CompatibilityFallbackHandler 1.3.0. */
  safeSingleton: Address;
  safeFallbackHandler: Address;
  /**
   * The councils' code in a release the handler is about to switch to, deployed ahead of the
   * switch: pinned too, so pages keep reading governance at each head across it (chain/pins.ts).
   */
  next?: Pick<CodePins, "securityCouncil" | "emergencyUpgradeBoard">;
};

export type NetworkConfig = {
  name: NetworkName;
  label: string;
  chainId: number;
  upgradeHandler: Address | null;
  // First block with a handler event. Log scans never start earlier.
  upgradeHandlerDeployBlock: bigint;
  safeTxServiceUrl: string | null;
  safeWalletPrefix: string | null;
  l2RpcUrl: string | null;
  l2Governors: { protocol: Address | null };
  // Where the L2 governor's log index starts (else its deployment). Both null: no index (the
  // governor is read on demand).
  l2GovernorsFirstLogBlock: bigint | null;
  l2GovernorsDeployBlock: bigint | null;
  explorerUrl: string | null;
  l2ExplorerUrl: string | null;
  tallyUrl: string | null;
  standardLegalVetoDays: number;
  // The handler's delay from approval to "Ready" (UPGRADE_DELAY_PERIOD): 1 day, none on testnets.
  upgradeDelayDays: number;
  blockTimeSeconds: number;
  // A log that must exist on any RPC with full log history. If an RPC returns nothing for it,
  // the app says so instead of silently showing an incomplete list.
  logCanary: { address: Address; topic0: Hex; blockNumber: bigint } | null;
  codePins: CodePins | null;
};

const CHANGE_SECURITY_COUNCIL_TOPIC = toEventSelector("ChangeSecurityCouncil(address,address)");

export const NETWORKS: Record<1 | 11155111, NetworkConfig> = {
  1: {
    name: "mainnet",
    label: "Ethereum Mainnet",
    chainId: 1,
    upgradeHandler: "0xE30Dca3047B37dc7d88849dE4A4Dc07937ad5Ab3",
    upgradeHandlerDeployBlock: 21_788_382n,
    safeTxServiceUrl: "https://api.safe.global/tx-service/eth",
    safeWalletPrefix: "eth",
    l2RpcUrl: "https://mainnet.era.zksync.io",
    l2Governors: { protocol: "0x76705327e682F2d96943280D99464Ab61219e34f" },
    l2GovernorsFirstLogBlock: 49_077_771n,
    l2GovernorsDeployBlock: 41_196_850n,
    explorerUrl: "https://etherscan.io",
    l2ExplorerUrl: "https://explorer.zksync.io",
    tallyUrl: "https://tally.xyz/gov/zksync",
    standardLegalVetoDays: 3,
    upgradeDelayDays: 1,
    blockTimeSeconds: 12,
    logCanary: {
      address: "0xE30Dca3047B37dc7d88849dE4A4Dc07937ad5Ab3",
      topic0: CHANGE_SECURITY_COUNCIL_TOPIC,
      blockNumber: 21_788_382n,
    },
    codePins: {
      // The handler after ZIP-19 (Guardians dissolved; upgrade
      // 0xc334de7ae595405dd6a86ac80a33b0c60a956bd8eb815834167763d462f39933, implementation
      // 0xaD417a02cD56e535703404DEd7C8c5BaFE088DEE): SecurityCouncil
      // 0x29D2e773A31C07D375c50F0110422832bd044d08 (v31's, 8 members), the two-party
      // EmergencyUpgradeBoard 0x3DBD9c38cc4A0D380fE9E32ACE0D2b147aD29FF1 (Security Council + ZK
      // Foundation), and the ZK Foundation Safe 0xbC1653bd3829dfEc575AfC3816D4899cd103B51c (Safe
      // 1.3.0). zk-governance vb/remove-guardians-audit-fixes, read on mainnet at block 26,427,348.
      securityCouncil: "0xc04dd16b6d32e1606135aeb426f33c9487350fdc1faa21cec6ff4abfec5966e3",
      emergencyUpgradeBoard: "0x7a151987334e3757b74372ecffbbeaddcbba4478e99b8b7d6bf614a06e9abbd5",
      safeProxy: "0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000",
      safeSingleton: "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552",
      safeFallbackHandler: "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4",
    },
  },
  11155111: {
    name: "sepolia",
    label: "Sepolia",
    chainId: 11155111,
    upgradeHandler: "0x7444b49E49A4AD4376a3e3c036900869575f0FBf",
    upgradeHandlerDeployBlock: 6_380_336n,
    safeTxServiceUrl: "https://api.safe.global/tx-service/sep",
    safeWalletPrefix: "sep",
    l2RpcUrl: "https://sepolia.era.zksync.dev",
    l2Governors: { protocol: "0x5a6862ee581b6cDb517D24f0a69237f9D900C23C" },
    l2GovernorsFirstLogBlock: 3_590_083n,
    l2GovernorsDeployBlock: 3_584_343n,
    explorerUrl: "https://sepolia.etherscan.io",
    l2ExplorerUrl: "https://sepolia.explorer.zksync.io",
    tallyUrl: null,
    standardLegalVetoDays: 0,
    upgradeDelayDays: 0,
    blockTimeSeconds: 12,
    logCanary: {
      address: "0x7444b49E49A4AD4376a3e3c036900869575f0FBf",
      topic0: CHANGE_SECURITY_COUNCIL_TOPIC,
      blockNumber: 6_380_336n,
    },
    codePins: null,
  },
};

export function localNetwork(chainId: number): NetworkConfig {
  return {
    name: "local",
    label: `Local chain ${chainId}`,
    chainId,
    upgradeHandler: null,
    upgradeHandlerDeployBlock: 0n,
    safeTxServiceUrl: null,
    safeWalletPrefix: null,
    l2RpcUrl: null,
    l2Governors: { protocol: null },
    l2GovernorsFirstLogBlock: null,
    l2GovernorsDeployBlock: null,
    explorerUrl: null,
    l2ExplorerUrl: null,
    tallyUrl: null,
    standardLegalVetoDays: 3,
    upgradeDelayDays: 1,
    blockTimeSeconds: 12,
    logCanary: null,
    codePins: null,
  };
}

export function knownNetwork(chainId: number): NetworkConfig | null {
  return (NETWORKS as Record<number, NetworkConfig>)[chainId] ?? null;
}
