// The L1 RPC as the page may name it: its host only, never its path, query or user info (where
// providers put keys). A DNS name is cut to its last two labels (a provider's subdomain can name
// the account), which still tells one provider from another, and both from a local proxy (an
// address or localhost, shown whole). Plain http is said. Null for none, or the file build's
// `.invalid` placeholder.
export function rpcHostLabel(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  if (!host || host.endsWith(".invalid")) return null;
  const address = /^[\d.]+$/.test(host) || host.startsWith("[");
  const name = address || !host.includes(".") ? host : host.split(".").slice(-2).join(".");
  const port = parsed.port ? `:${parsed.port}` : "";
  return `${parsed.protocol === "http:" ? "http://" : ""}${name}${port}`;
}
