// The site's pages (standalone/routes.tsx), and a link to one with its parameters filled in.
type Paths = {
  "/": never;
  "/app/proposals": never;
  "/app/proposals/new": never;
  "/app/proposals/:id": { id: string };
  "/app/emergency": never;
  "/app/emergency/new": never;
  "/app/emergency/:id": { id: string };
  "/app/freeze": never;
  "/app/freeze/:action": { action: string };
  "/app/l2-cancellations": never;
  "/app/l2-cancellations/new": never;
  "/app/l2-cancellations/:id": { id: string };
  "/app/transactions/:hash": { hash: string };
  "/settings": never;
  "/resources/refresh": never;
};

export function $path<P extends keyof Paths>(
  path: P,
  ...params: Paths[P] extends never ? [] : [Paths[P]]
): string {
  const values = (params[0] ?? {}) as Record<string, string>;
  return path.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(values[name] ?? ""));
}
