/**
 * Guard for the dev-server route /api/ai/* (vite.config.ts).
 *
 * The dev route may hold a real OPENROUTER_API_KEY from .env.local, so only local clients may call it.
 * Without this check the route is reachable by:
 *  - any web page in a browser on this machine (a "neighbour" dev server or a malicious site via DNS rebinding:
 *    the attacker's domain resolves to 127.0.0.1, the request reaches Vite, but Origin/Host still name the attacker);
 *  - any local process — those legitimately have no Origin, so for them the Host header must be local.
 *
 * Rules:
 *  - Origin present → its hostname must be localhost / 127.0.0.1 / [::1] (the port is free: local tools
 *    such as the Playwright harness run on their own ports);
 *  - Host must be present and local (protects against DNS rebinding, where Host names the attacker's domain);
 *  - anything else → 403.
 *
 * The production build is not affected: in the desktop app AI goes through the C# host (bridge), this route only exists in dev mode.
 */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export type GuardHeaders = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] : value) ?? "";

export function isLocalDevAiRequest(headers: GuardHeaders): boolean {
  const origin = first(headers.origin ?? headers.Origin).trim();
  if (origin) {
    let url: URL;
    try { url = new URL(origin); } catch { return false; }
    if (!LOCAL_HOSTNAMES.has(url.hostname)) return false;
  }
  const host = first(headers.host ?? headers.Host).trim();
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, "");
  return LOCAL_HOSTNAMES.has(hostname);
}
