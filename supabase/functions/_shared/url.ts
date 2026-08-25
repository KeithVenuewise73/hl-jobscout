// SSRF-safe URL validation + normalization.
//
// VENDORED from hl-bos-platform: supabase/functions/_shared/discovery/url.ts
// (the Website Assessment Collector's validator). Copied rather than rewritten
// because it is already proven; if you fix a hole here, fix it there too.
//
// Security is designed in from the first line. Every URL — the target and EVERY
// redirect hop — is validated for scheme, embedded credentials, port, and (after
// DNS resolution) resolved IP address, so a hostname that resolves to a private/
// loopback/link-local/metadata address is rejected (DNS-rebinding defense). DNS
// resolution is INJECTED (`resolve`) so this module is deterministic and offline
// in tests; production wires a real resolver and re-validates at connect time.

export class SsrfError extends Error {
  constructor(public readonly reason: string) {
    super(`ssrf_blocked:${reason}`);
    this.name = "SsrfError";
  }
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const DEFAULT_ALLOWED_PORTS = new Set(["", "80", "443"]);
const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "mc_eid",
  "igshid",
  "ref",
  "ref_src",
  "_ga",
  "yclid",
];

// ---- IP classification -----------------------------------------------------
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

function ipv4Blocked(ip: string): string | null {
  const n = ipv4ToInt(ip);
  if (n === null) return null; // not an IPv4 literal
  const inRange = (a: string, bits: number) =>
    n >>> (32 - bits) === ipv4ToInt(a)! >>> (32 - bits);
  if (inRange("0.0.0.0", 8)) return "unspecified";
  if (inRange("10.0.0.0", 8)) return "private";
  if (inRange("127.0.0.0", 8)) return "loopback";
  if (inRange("169.254.0.0", 16)) return "link_local"; // incl. 169.254.169.254 metadata
  if (inRange("172.16.0.0", 12)) return "private";
  if (inRange("192.168.0.0", 16)) return "private";
  if (inRange("100.64.0.0", 10)) return "cgnat";
  if (inRange("192.0.0.0", 24)) return "special";
  if (inRange("198.18.0.0", 15)) return "benchmark";
  if (inRange("224.0.0.0", 4)) return "multicast";
  if (inRange("240.0.0.0", 4)) return "reserved";
  return null;
}

function ipv6Blocked(ipRaw: string): string | null {
  const ip = ipRaw.toLowerCase().replace(/^\[|\]$/g, "");
  if (!ip.includes(":")) return null; // not IPv6
  if (ip === "::1") return "loopback";
  if (ip === "::") return "unspecified";
  if (
    ip.startsWith("fe80") ||
    ip.startsWith("fe9") ||
    ip.startsWith("fea") ||
    ip.startsWith("feb")
  )
    return "link_local";
  if (/^f[cd]/.test(ip)) return "unique_local"; // fc00::/7
  // IPv4-mapped / -embedded (::ffff:a.b.c.d or ::a.b.c.d)
  const v4 = ip.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) return ipv4Blocked(v4[1]);
  return null;
}

/** Returns a block reason for an IP literal, or null if it is a public address. */
export function ipBlockedReason(ip: string): string | null {
  return ipv4Blocked(ip) ?? ipv6Blocked(ip);
}

// ---- URL validation --------------------------------------------------------
export interface UrlValidationOptions {
  allowedPorts?: Set<string>;
}

/** Structural validation (scheme/credentials/port/IP-literal host). Throws SsrfError. */
export function validateUrl(raw: string, opts: UrlValidationOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError("malformed_url");
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) throw new SsrfError("scheme");
  if (url.username || url.password) throw new SsrfError("embedded_credentials");
  const ports = opts.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  if (!ports.has(url.port)) throw new SsrfError("port");
  // If the host is an IP literal, classify it immediately.
  const host = url.hostname;
  const literal = ipBlockedReason(host.replace(/^\[|\]$/g, ""));
  if (literal) throw new SsrfError(`ip_${literal}`);
  // Reject obvious internal hostnames with no dot (e.g. "localhost", "metadata").
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal"))
    throw new SsrfError("internal_hostname");
  return url;
}

/** Resolve a hostname and reject if ANY returned address is blocked (rebinding defense). */
export async function resolveAndValidate(
  hostname: string,
  resolve: (h: string) => Promise<string[]>,
): Promise<string[]> {
  const ips = await resolve(hostname);
  if (!ips || ips.length === 0) throw new SsrfError("dns_no_records");
  for (const ip of ips) {
    const reason = ipBlockedReason(ip);
    if (reason) throw new SsrfError(`dns_${reason}`);
  }
  return ips;
}

/** Validate a redirect target (absolute or relative to `base`). Throws SsrfError. */
export function validateRedirect(
  location: string,
  base: string,
  opts?: UrlValidationOptions,
): URL {
  let abs: string;
  try {
    abs = new URL(location, base).toString();
  } catch {
    throw new SsrfError("malformed_redirect");
  }
  return validateUrl(abs, opts);
}

/** Canonicalize: lowercase host, drop default port + fragment, strip tracking params. */
export function normalizeUrl(raw: string): string {
  const url = new URL(raw); // caller validates separately
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  )
    url.port = "";
  for (const p of TRACKING_PARAMS) url.searchParams.delete(p);
  // stable param order
  url.searchParams.sort();
  let s = url.toString();
  if (s.endsWith("/") && url.pathname === "/") s = s.slice(0, -1); // trim bare trailing slash
  return s;
}
