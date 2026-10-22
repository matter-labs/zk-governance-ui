import { fileURLToPath } from "node:url";
import type { Plugin, UserConfig } from "vite";

// The whole site as one file (dist/verifier.html at the repo root, after inline.mjs): no server,
// opened from disk.
const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const shim = (find: string, file: string) => ({ find, replacement: at(`./shims/${file}`) });

// WalletConnect sends an "INIT" usage event to pulse.walletconnect.org each time it starts, whatever
// `telemetryEnabled` says: @walletconnect/core 2.17's EventClient.init checks only isTestRun. With
// telemetry off (wallet-provider.tsx), that event is off too. The build fails if the code it
// changes is not there, so a new version is looked at again rather than sending it.
const walletConnectTelemetryOff: Plugin = {
  name: "walletconnect-telemetry-off",
  transform(code, id) {
    if (!id.includes("/@walletconnect/core/dist/")) return null;
    const quiet = code.replace(
      /this\.init=async\(\)=>\{if\(!([\w.$]+)\(\)\)/,
      "this.init=async()=>{if(this.telemetryEnabled&&!$1())"
    );
    if (quiet === code) this.error(`${id}: EventClient.init changed; check what it sends`);
    return { code: quiet, map: null };
  },
};

const config: UserConfig = {
  root: at("."),
  esbuild: { jsx: "automatic" },
  plugins: [walletConnectTelemetryOff],
  resolve: {
    alias: [
      shim("@config/env.server", "env.ts"),
      shim("@config/log.server", "log.ts"),
      shim("@config/local-settings.server", "local-settings.ts"),
      shim("@remix-run/react", "remix-react.tsx"),
      shim("@remix-run/node", "remix-node.ts"),
      shim("node:crypto", "crypto.ts"),
      shim("node:async_hooks", "async-hooks.ts"),
      shim("node:fs/promises", "fs.ts"),
      shim("node:path", "path.ts"),
      shim("@/fonts.css", "fonts.css"),
      { find: /^@config\//, replacement: `${at("../config")}/` },
      { find: /^@\//, replacement: `${at("../app")}/` },
    ],
  },
  build: {
    outDir: at("./dist"),
    emptyOutDir: true,
    target: "es2022",
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
};
export default config;
