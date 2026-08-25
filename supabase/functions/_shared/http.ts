// The production HTTP client the adapters get injected.
//
// Board tokens and workday hosts are DATA — they come out of the companies
// table — and this runs server-side on Supabase's network. So every URL is
// SSRF-validated before the request and every redirect hop is validated again,
// and responses are capped in bytes and seconds.

import { SsrfError, validateRedirect, validateUrl } from "./url.ts";
import type { FetchJson } from "./adapters.ts";

const UA = "Mozilla/5.0 (compatible; JobScout/1.0)";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export class HttpError extends Error {
  constructor(public readonly status: number, msg: string) {
    super(msg);
    this.name = "HttpError";
  }
}

export interface ClientOptions {
  timeoutMs?: number;
  resolve?: (h: string) => Promise<string[]>;
}

/**
 * Build a FetchJson. `body` present => POST JSON, else GET.
 * Redirects are followed manually so each hop can be re-validated.
 */
export function makeClient(opts: ClientOptions = {}): FetchJson {
  const timeoutMs = opts.timeoutMs ?? 25_000;

  return async function call(url: string, body?: unknown): Promise<unknown> {
    let current = validateUrl(url).toString();

    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECTS) throw new HttpError(0, "too_many_redirects");

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(current, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "User-Agent": UA,
            "Accept": "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "manual",
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new HttpError(res.status, "redirect_without_location");
        res.body?.cancel();
        current = validateRedirect(loc, current).toString();
        continue;
      }

      if (res.status >= 400) {
        res.body?.cancel();
        throw new HttpError(res.status, `http_${res.status}`);
      }

      const text = await readCapped(res, MAX_BYTES);
      try {
        return JSON.parse(text);
      } catch {
        throw new HttpError(res.status, "response_not_json");
      }
    }
  };
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new HttpError(0, "response_too_large");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(buf);
}

export { SsrfError };
