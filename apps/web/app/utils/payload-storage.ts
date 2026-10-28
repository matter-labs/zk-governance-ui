// Emergency payloads stay in this browser, keyed by the id they hash to, with when they were
// prepared or loaded here. They are confidential until executed, and Chrome lets every page opened
// from a file read this one's localStorage (they share the file:// origin), so a payload is kept
// for its tab only (sessionStorage) unless the user asks to keep it after the tab closes
// (localStorage, keepPayload). Either way it is listed under Prepared in this browser while it is
// there. It leaves the browser only when the user asks: Simulate or Check calls (an eth_call to
// their RPC).
import { STORAGE_PREFIX } from "@/common/storage-prefix";

const PREFIX = `${STORAGE_PREFIX}emergency-payload:`;
const key = (id: string) => `${PREFIX}${id.toLowerCase()}`;

/** `kept`: in localStorage, after the tab closes too; else this tab's only. */
export type SavedPayload = { id: string; payload: unknown; savedAt: number; kept: boolean };

type Stored = { payload: unknown; savedAt: number };

function parse(raw: string | null): Stored | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && "payload" in value && "savedAt" in value)
      return value as Stored;
    // A copy saved as the bare payload (before).
    return { payload: value, savedAt: Date.now() };
  } catch {
    return null;
  }
}

function read(storage: Storage, id: string): Stored | null {
  try {
    return parse(storage.getItem(key(id)));
  } catch {
    return null;
  }
}

/** For this tab, or where it is already kept (asked for before): its time stays. */
export function savePayload(id: string, payload: unknown) {
  try {
    const kept = read(localStorage, id);
    const savedAt = kept?.savedAt ?? read(sessionStorage, id)?.savedAt ?? Date.now();
    (kept ? localStorage : sessionStorage).setItem(
      key(id),
      JSON.stringify({ payload, savedAt } satisfies Stored)
    );
  } catch {}
}

/** Kept after the tab closes too, as the user asked (localStorage, readable by file:// pages). */
export function keepPayload(id: string) {
  try {
    const stored = read(sessionStorage, id);
    if (!stored) return;
    localStorage.setItem(key(id), JSON.stringify(stored));
    sessionStorage.removeItem(key(id));
  } catch {}
}

export function loadPayload(id: string): unknown | null {
  return (read(sessionStorage, id) ?? read(localStorage, id))?.payload ?? null;
}

export function forgetPayload(id: string) {
  try {
    localStorage.removeItem(key(id));
    sessionStorage.removeItem(key(id));
  } catch {}
}

function listIn(storage: Storage, kept: boolean): SavedPayload[] {
  try {
    return Object.keys(storage)
      .filter((k) => k.startsWith(PREFIX))
      .flatMap((k) => {
        const stored = parse(storage.getItem(k));
        return stored ? [{ id: k.slice(PREFIX.length), ...stored, kept }] : [];
      });
  } catch {
    return [];
  }
}

/** Every payload kept here (this tab's and those kept after it), the newest first. */
export function listPayloads(): SavedPayload[] {
  const kept = listIn(localStorage, true);
  const tab = listIn(sessionStorage, false).filter((p) => !kept.some((k) => k.id === p.id));
  return [...tab, ...kept].sort((a, b) => b.savedAt - a.savedAt);
}

/** True for a change to the payloads kept here made in another tab. */
export const isPayloadChange = (event: StorageEvent) =>
  event.key === null || event.key.startsWith(PREFIX);
