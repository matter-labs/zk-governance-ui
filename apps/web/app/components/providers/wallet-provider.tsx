import { STORAGE_PREFIX } from "@/common/storage-prefix";
import Avatar from "@/components/connect-button/avatar";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { type Chain, custom, defineChain } from "viem";
import {
  type State,
  WagmiProvider,
  cookieStorage,
  createConfig,
  createStorage,
  useAccount,
  useSwitchChain,
} from "wagmi";
import { mainnet, sepolia } from "wagmi/chains";
import { walletConnect } from "wagmi/connectors";

const queryClient = new QueryClient();
const walletTheme = lightTheme({
  accentColor: "hsl(var(--primary))",
  accentColorForeground: "hsl(var(--primary-foreground))",
  borderRadius: "large",
  fontStack: "system",
});
// RainbowKit defaults dim text with alpha; keep wallet dialogs as readable as the app.
Object.assign(walletTheme.colors, {
  modalBackground: "hsl(var(--popover))",
  modalText: "hsl(var(--popover-foreground))",
  modalTextDim: "hsl(var(--muted-foreground))",
  modalTextSecondary: "hsl(var(--muted-foreground))",
  closeButton: "hsl(var(--muted-foreground))",
  connectButtonText: "hsl(var(--foreground))",
  error: "hsl(var(--destructive))",
});

// The browser never talks to an RPC of its own: chain reads happen on the server through the
// user's RPC, and signing/sending go through the connected wallet. Without this, wagmi would send
// lookups for the connected account (e.g. ENS) to a public third-party RPC.
export const noBrowserRpc = custom({
  request: async ({ method }) => {
    throw new Error(`${method}: this app reads the chain on its server, not from the browser`);
  },
});

// The chain's RPC is where WalletConnect's provider sends any method the wallet did not approve
// (its rpcMap: the transport's URL, else the chain's first). viem retries a refused
// eth_sendTransaction as wallet_sendTransaction, so with viem's chain objects the whole
// transaction, an emergency payload before it executes included, would go to eth.merkle.io (or
// drpc, or WalletConnect's own RPC with none). An address that never resolves: nothing goes out.
const NO_RPC = { default: { http: ["https://wallet-rpc.invalid"] } } as const;

export function chainFor(chainId: number, label: string): Chain {
  if (chainId === mainnet.id) return { ...mainnet, rpcUrls: NO_RPC };
  if (chainId === sepolia.id) return { ...sepolia, rpcUrls: NO_RPC };
  return defineChain({
    id: chainId,
    name: label,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: NO_RPC,
  });
}

/** True inside an iframe, e.g. when Safe{Wallet} opens the app as a Safe App. */
export const isFramed = () => typeof window !== "undefined" && window.parent !== window;

// A wallet is only needed to sign as a member Safe or to send a transaction, and is reached only
// over WalletConnect (a project id in Settings): members connect their Safe from Safe{Wallet}, and
// anyone can connect a wallet app to send. Browser extensions cannot connect to the single-file
// build (they talk to the page through window.postMessage, which browsers drop on file:// pages), so
// installed ones are not discovered either: listed, they would hang at "Confirm in the extension".
//
// One WalletConnect connector, which opens WalletConnect's own modal: its QR to scan, and Copy link
// to paste into Safe{Wallet}. (RainbowKit's WalletConnect wallet adds a second connector for that
// modal, and with it a second WalletConnect client on the same storage and relay identity.)
const WALLETCONNECT_MODAL = {
  themeMode: "light",
  // Only the QR and its link: no directory of wallets fetched from WalletConnect.
  enableExplorer: false,
  themeVariables: {
    "--wcm-accent-color": "#0C18EC",
    "--wcm-background-color": "#0C18EC",
    "--wcm-font-family": "Inter, system-ui, sans-serif",
    "--wcm-z-index": "60",
  },
} as const;

// wagmi's record of the connection (which connector, which chains it asked for). A page opened from
// a file keeps no cookies in Chrome: there, localStorage, so a reload resumes the WalletConnect
// session instead of finding it unknown and ending it.
function walletStorage() {
  if (typeof window !== "undefined" && window.location.protocol === "file:") {
    try {
      return window.localStorage;
    } catch {}
  }
  return cookieStorage;
}
// A wallet app approves a WalletConnect session for every network it has, and the session starts
// on the first (MetaMask Mobile: Ethereum, whatever this page is for). Once connected elsewhere, the
// wallet is moved to this page's chain: at once when the session includes it, else the wallet asks
// (a phone wallet has no network menu for a WalletConnect site). Asked once per chain it is on.
function StayOnChain({ chainId }: { chainId: number }) {
  const { status, chainId: connected } = useAccount();
  const { switchChain } = useSwitchChain();
  const asked = useRef<number | null>(null);
  useEffect(() => {
    if (status !== "connected" || connected === undefined || connected === chainId) return;
    if (asked.current === connected) return;
    asked.current = connected;
    // Refused or failed: the header's Switch button stays, and says what to do.
    switchChain({ chainId }, { onError: () => {} });
  }, [status, connected, chainId, switchChain]);
  return null;
}

export function WalletProvider({
  children,
  initialState,
  projectId,
  chainId,
  chainLabel,
}: {
  children: ReactNode;
  initialState?: State;
  projectId: string | null;
  chainId: number;
  chainLabel: string;
}) {
  const config = useMemo(() => {
    const chain = chainFor(chainId, chainLabel);
    return createConfig({
      chains: [chain] as [Chain],
      transports: { [chain.id]: noBrowserRpc },
      ssr: true,
      storage: createStorage({ storage: walletStorage(), key: `${STORAGE_PREFIX}wagmi` }),
      multiInjectedProviderDiscovery: false,
      // Without a project id there is no wallet.
      connectors: projectId
        ? [
            walletConnect({
              projectId,
              showQrModal: true,
              qrModalOptions: WALLETCONNECT_MODAL,
              customStoragePrefix: STORAGE_PREFIX || undefined,
              // No usage events to WalletConnect (pulse.walletconnect.org) on every page load.
              telemetryEnabled: false,
            }),
          ]
        : [],
    });
  }, [projectId, chainId, chainLabel]);

  return (
    <WagmiProvider config={config} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        <StayOnChain chainId={chainId} />
        <RainbowKitProvider
          theme={walletTheme}
          avatar={Avatar}
          modalSize="compact"
          appInfo={{ appName: "ZKsync Governance" }}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
