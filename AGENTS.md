# AGENTS.md

How to build this single-file app, change it and run its tests. Read the rules first.

## Rules

- Read-only on mainnet. Never sign, never send a transaction, never POST to the Safe Transaction Service. Signing is
  the signer's own action in their Safe; the page only reads.
- Report hashes and addresses in full. A signer compares them character by character with their hardware wallet.
- A signature counts only when the governance contract accepted it in an `eth_call` (`status` `"valid"`). Safe's API
  only supplies candidates; a member it cannot answer for is `"unavailable"`, never `"missing"`.
- Never print RPC URLs or API keys, and never commit a key (the Sepolia deployer's lives in
  `apps/web/.cache/sepolia-test/deployer.key`, which is ignored).

## Build

Needs Node.js 20+ (on Node 25+, use `npx pnpm@9.7.1` where these say `corepack pnpm`).

```bash
corepack pnpm install
corepack pnpm build                                              # apps/web/standalone/dist/verifier.html
corepack pnpm --filter web build:sepolia-test                    # the Sepolia test deployment's page
ECOSYSTEM=testnet-3 corepack pnpm --filter web build:ecosystem   # another ecosystem's, from standalone/ecosystems/<name>.json
```

The page is the app's route modules under React Router's hash router (`verifier.html#/app/proposals/0x…`). Its
`.server` modules run in the browser: `standalone/vite.config.ts` swaps Node and Remix modules for the shims in
`standalone/shims` (settings and caches in `localStorage`), and `standalone/inline.mjs` inlines everything into one
file.

## Test

```bash
corepack pnpm check && corepack pnpm typecheck   # lint + types
corepack pnpm test                               # unit and engine tests, no network
cd apps/web && corepack pnpm test:i              # mainnet, read-only (L1_RPC_URL; default: a public RPC)
cd apps/web && corepack pnpm test:fork           # signing and execution paths on an anvil fork (needs `anvil`; FORK_URL)
```

Test data recorded from mainnet lives in `apps/web/test/fixtures` (re-record with
`apps/web/test/support/record-fixtures.ts`). The fork tests make a public anvil test key an owner of member Safes, on
the local fork only, and serve its signatures from a local mock of the Safe API (`apps/web/test/support`).

## Map

- `apps/web/standalone/`: the single-file build (entry, routes, shims), the Sepolia test deployment
  (`sepolia-test/`) and other ecosystems' configs (`ecosystems/`).
- `apps/web/app/.server/`: chain and Safe access, log scanning, the verification engine (`signatures.ts`), and one
  module per flow (`flows/`). `chain/` holds the read-only JSON-RPC lanes, the log indexes and the revert
  classification, `sync/` the engine, `safe/store.ts` the Safe listings, `persist/` the chain cache.
- `apps/web/app/common/`: ABIs, EIP-712 types, Safe hashes, calldata builders, pinned network addresses
  (`networks.ts`).
- `apps/web/app/common/abi-catalog/`: the functions and address labels the call decoder (`calldata.ts`) uses,
  imported from a folder of ABI files with `apps/web/scripts/import-abis.ts`.
- `apps/web/app/routes/`: the pages (`app/…`, `settings`) and the in-page resources (`resources+/`).
- `apps/web/config/`: the Node-side settings the tests run the `.server` modules with.
