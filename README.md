# ZKsync Governance verifier

Check ZKsync governance actions and their signatures yourself, from one HTML file opened from disk. There is no server:
the page reads every proposal from the chain through **your** RPC, takes members' signatures from the Safe Transaction
Service only as candidates, and counts a signature only when the governance contract itself accepts it in an
`eth_call`. It never posts to Safe, and signs or sends nothing on its own.

It covers protocol upgrades (Security Council and Guardian approval, legal veto extension), emergency upgrades,
freeze / unfreeze / soft-freeze threshold requests and Guardian vetoes of L2 proposals. For each it shows what is
signed, the hashes a Safe owner's hardware wallet displays, who has signed, whether the threshold holds, and the
calldata to execute.

## Get the file

Download `verifier.html` from the `verifier-html` artifact of a CI run, or build it. Building needs Node.js 20 or newer:

```bash
git clone https://github.com/matter-labs/zk-governance-ui.git && cd zk-governance-ui
corepack pnpm install && corepack pnpm build
```

The file is `apps/web/standalone/dist/verifier.html`.

## Use it

Open `verifier.html` in a browser. Until an RPC is saved only **Settings** shows:

| Setting | Use |
| --- | --- |
| Ethereum L1 RPC | Required: an Ethereum mainnet or Sepolia RPC with log history (any archive RPC works, e.g. `https://mainnet.gateway.tenderly.co`). The network is detected from it |
| ZKsync L2 RPC | For vetoes and L2 links (default: the public one) |
| Safe API key | Without one, Safe allows 2 requests/s and 5,000 a month per IP: enough for one signer |
| WalletConnect project id | Free at [cloud.reown.com](https://cloud.reown.com); the page has a default |

Settings, the chain cache and payloads you load stay in this browser's storage and nowhere else.

## Sign

In the page, **Connect wallet** → copy the WalletConnect link. In Safe{Wallet}, open your member Safe →
WalletConnect → paste it. **Your signature** then offers that Safe's signature: press **Review and sign**, then
compare the hashes on your hardware wallet with the ones in the review (Safe{Wallet} shows the same ones under
**SafeMessage details**). Once your Safe's owners have confirmed, the signature appears on the page, verified on-chain.
Browser extension wallets cannot reach a page opened from disk; any WalletConnect wallet can send the transactions.

## Other builds

- [Sepolia test deployment](apps/web/standalone/sepolia-test/README.md): governance contracts on Sepolia whose
  members one address controls, to try signing and executing end to end (`corepack pnpm --filter web build:sepolia-test`).
- [Another ecosystem](apps/web/standalone/ecosystems/README.md) running the same contracts, from a config
  (`ECOSYSTEM=testnet-3 corepack pnpm --filter web build:ecosystem`).

## Security model

**What you trust.** Your RPC, the ProtocolUpgradeHandler address pinned in `apps/web/app/common/networks.ts`, and the
file you open. Everything else is derived from the handler through your RPC: councils, members, thresholds, nonces,
EIP-712 domains. The page checks the contracts against each other and shows a red banner if they disagree.

**What you don't trust.** The Safe Transaction Service. Its answers are only a place to look for signatures. A message
is used only if it is filed under the hash this page computes for that Safe and that action, and a signature counts
only once the contract that will consume it (`checkSignatures`, or the Safe's `isValidSignature`) accepts it in an
`eth_call`. An RPC failure is reported as a failure, never as an invalid signature; a member Safe's API cannot answer
for is shown as unavailable, never as missing.

**What you check yourself.** Before signing, compare the domain hash and message hash on your hardware wallet with
the page. They are computed per member Safe and cross-checked against the Safe's on-chain `domainSeparator()`.

**Emergency payloads** are confidential until executed. The page checks a payload against the signed id in this
browser; it leaves the browser only as an `eth_call` to your RPC when you press **Simulate via your RPC**.

**Incomplete data.** Some RPCs return empty `eth_getLogs` results for old blocks instead of an error. A canary (the
handler's deployment event) detects this, and the page then warns that lists may be incomplete. Pages opened by id
still verify, because they read state directly.

## Develop

From the repo root: `corepack pnpm check` (lint), `corepack pnpm typecheck`, `corepack pnpm test` (unit and engine
tests, no network). From `apps/web`: `corepack pnpm test:i` (read-only against mainnet; `L1_RPC_URL` to choose the
RPC) and `corepack pnpm test:fork` (signing and execution paths on an anvil fork; needs `anvil`). The call decoder's
function catalog is regenerated with `apps/web/scripts/import-abis.ts`. [AGENTS.md](AGENTS.md) has the rules for
working on it with an agent.

Licensed under MIT.
