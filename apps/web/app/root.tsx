import { appStatus, shellChain } from "@/.server/status";
import { statusRevs } from "@/.server/sync/content";
import { watchItems, watchKeys } from "@/.server/sync/presence";
import AppShell, { AppFrame, StatusProblem } from "@/components/app-shell";
import { GeneralErrorBoundary } from "@/components/error-boundary";
import { ChainContext } from "@/components/governance-context";
import { PresenceProvider } from "@/components/presence";
import { KeepScrollOnReload } from "@/components/keep-scroll";
import { WalletProvider } from "@/components/providers/wallet-provider";
import { useNonce } from "@/utils/nonce-provider";
import { shouldRevalidateRoot } from "@/utils/revalidation";
import { rpcHostLabel } from "@/utils/rpc-host";
import { type CLIENT_ENV, clientEnv, env as serverEnv } from "@config/env.server";
import { type LinksFunction, type LoaderFunctionArgs, defer } from "@remix-run/node";
import {
  Await,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  type ShouldRevalidateFunction,
  useLoaderData,
  useLocation,
} from "@remix-run/react";
import { Suspense } from "react";
import { Toaster } from "react-hot-toast";
import {
  type State,
  deserialize as deserializeWagmiCookie,
  parseCookie as parseWagmiCookie,
} from "wagmi";

import "@/globals.css";
import "@/fonts.css";
import "@rainbow-me/rainbowkit/styles.css";

export const links: LinksFunction = () => [
  {
    rel: "preload",
    href: "/fonts/inter-latin.woff2",
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous",
  },
];

// Nothing here waits on the network before the page's first bytes: the status is deferred, and
// the chain is in hand once the server has read it (before it starts listening), else deferred too.
export function loader({ request }: LoaderFunctionArgs) {
  const cookies = request.headers.get("Cookie");
  const wagmiCookie = cookies ? parseWagmiCookie(cookies, "wagmi.store") : undefined;
  const status = appStatus({ freshness: "page" });
  return defer({
    env: clientEnv,
    wagmiCookie,
    watch: watchItems(request, [watchKeys.status]),
    presence: { awayMs: serverEnv.SYNC_AWAY_MS },
    chain: shellChain(),
    // The L1 RPC's host, said in the header: an RPC changed behind the page's back is seen.
    rpc: rpcHostLabel(serverEnv.L1_RPC_URL),
    status,
    revs: statusRevs(status),
  });
}

// Not on every navigation: only when revalidation.ts says the status must be read again.
export const shouldRevalidate: ShouldRevalidateFunction = shouldRevalidateRoot;

export default function App() {
  const nonce = useNonce();
  const { env } = useLoaderData<typeof loader>();
  return (
    <Document nonce={nonce} env={env} allowIndexing={env.ALLOW_INDEXING}>
      <AppBody />
    </Document>
  );
}

/** Everything inside <body> but the toaster and scripts: shared with the single-file build. */
export function AppBody() {
  const { env, wagmiCookie, chain, status, presence, rpc } = useLoaderData<typeof loader>();
  const initialState = wagmiCookie
    ? deserializeWagmiCookie<{ state: State }>(wagmiCookie).state
    : undefined;

  // The shell, the navigation and the page render at once: the chain id the wallet needs is in
  // hand unless the server has not read it yet. The status fills in as it is read.
  return (
    <PresenceProvider awayMs={presence.awayMs}>
      <Suspense fallback={<AppFrame />}>
        <Await resolve={chain} errorElement={<ChainProblem status={status} rpc={rpc} />}>
          {(chain) => (
            <ChainContext.Provider value={chain}>
              <WalletProvider
                initialState={initialState}
                projectId={env.WALLET_CONNECT_PROJECT_ID}
                chainId={chain.chainId}
                chainLabel={chain.label}
              >
                <AppShell status={status} rpc={rpc}>
                  <Outlet />
                </AppShell>
              </WalletProvider>
            </ChainContext.Provider>
          )}
        </Await>
      </Suspense>
    </PresenceProvider>
  );
}

export function AppToaster() {
  return (
    <Toaster
      position="bottom-center"
      // Above Your signature's bar while it is shown.
      containerStyle={{ bottom: "calc(var(--action-bar, 0px) + 16px)" }}
      toastOptions={{
        className: "!rounded-xl !text-sm",
        style: {
          background: "hsl(var(--popover))",
          color: "hsl(var(--popover-foreground))",
        },
      }}
    />
  );
}

/**
 * The RPC's chain could not be read: why, from the status (which failed on the same read). Settings
 * still opens (it needs no chain), so a dead or wrong RPC is changed from the page.
 */
function ChainProblem({
  status,
  rpc,
}: {
  status: ReturnType<typeof useLoaderData<typeof loader>>["status"];
  rpc: string | null;
}) {
  const { pathname } = useLocation();
  if (pathname === "/settings") return <SettingsAlone />;
  return (
    <Suspense fallback={<AppFrame />}>
      <Await
        resolve={status}
        errorElement={
          <StatusProblem
            error="The app could not read which chain the RPC is on."
            hint="Check the L1 RPC in Settings: it must be reachable and on Ethereum mainnet or Sepolia."
            rpc={rpc}
          />
        }
      >
        {(status) =>
          status.ok ? (
            <StatusProblem
              error="The app could not read which chain the RPC is on."
              hint="Reload the page."
              rpc={rpc}
            />
          ) : (
            <StatusProblem error={status.error} hint={status.hint} rpc={rpc} />
          )
        }
      </Await>
    </Suspense>
  );
}

/** Settings while no chain can be read: the page alone, with a way back. */
function SettingsAlone() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12" data-testid="settings-alone">
      <Link to="/" className="mb-6 inline-block text-brand-700 text-sm hover:underline">
        ← Back
      </Link>
      <Outlet />
    </div>
  );
}

function Document({
  children,
  nonce,
  env,
  allowIndexing,
}: {
  children: React.ReactNode;
  nonce: string;
  env?: CLIENT_ENV;
  allowIndexing?: boolean;
}) {
  return (
    <html lang="en">
      <head>
        <Meta />
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {allowIndexing ? null : <meta name="robots" content="noindex, nofollow" />}
        <Links />
      </head>
      <body className="min-h-screen bg-background text-foreground">
        {children}
        <AppToaster />
        <script
          nonce={nonce}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: public client env only
          dangerouslySetInnerHTML={{ __html: `window.ENV = ${JSON.stringify(env)}` }}
          suppressHydrationWarning
        />
        <ScrollRestoration nonce={nonce} />
        <KeepScrollOnReload />
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  const nonce = useNonce();
  return (
    <Document nonce={nonce}>
      <div className="mx-auto max-w-3xl px-6 py-24">
        <GeneralErrorBoundary />
      </div>
    </Document>
  );
}
