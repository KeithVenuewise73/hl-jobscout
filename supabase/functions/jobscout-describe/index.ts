// jobscout-describe — fetch a posting's real description from the employer.
//
// WIRING ONLY; the extraction lives in ../_shared/describe.ts and is tested
// offline by ../tests/describe.test.ts.
//
// Takes the target URLs in the request body rather than reading them from a
// column, because the url we store is the LINKEDIN link — the one Keith clicks
// and the one we must not fetch. Pairing a job with its employer-side URL is
// still a manual step; a description_url column is the next move and needs a
// migration, which needs approval.
//
// POST {"jobs":[{"id":1,"url":"https://employer.example/jobs/123"}]}

import { createClient } from "jsr:@supabase/supabase-js@2";
import { blockedSource, extract } from "../_shared/describe.ts";
import { validateRedirect, validateUrl } from "../_shared/url.ts";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124 Safari/537.36";
const PAGE_TIMEOUT_MS = 15_000;
const MAX_HTML = 400 * 1024;
const MAX_JOBS = 25;

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const dec = new TextDecoder();
  let out = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    out += dec.decode(value, { stream: true });
    if (total >= max) {
      await reader.cancel();
      break;
    }
  }
  return out;
}

// Arbitrary third-party URLs, so every hop is SSRF-checked — same guard the
// discovery crawler uses.
async function fetchPage(url: string): Promise<string> {
  let current = validateUrl(url).toString();
  for (let hop = 0; hop <= 5; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current, {
        headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml" },
        redirect: "manual",
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      res.body?.cancel();
      if (!loc) throw new Error("redirect_without_location");
      const next = validateRedirect(loc, current).toString();
      // A redirect can land on a site we refuse to crawl. Re-check every hop,
      // or the block is one 302 away from meaningless.
      const b = blockedSource(next);
      if (b) throw new Error(`redirected to ${b}`);
      current = next;
      continue;
    }
    if (res.status >= 400) {
      res.body?.cancel();
      throw new Error(`http_${res.status}`);
    }
    return await readCapped(res, MAX_HTML);
  }
  throw new Error("too_many_redirects");
}

Deno.serve(async (req) => {
  const started = Date.now();
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "jobscout" } },
  );

  let body: { jobs?: { id: number; url: string }[] };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "body must be JSON: {jobs:[{id,url}]}" }, 400);
  }
  const wanted = (body.jobs ?? []).slice(0, MAX_JOBS);
  if (!wanted.length) return json({ ok: false, error: "no jobs given" }, 400);

  const detail: unknown[] = [];
  let updated = 0;

  for (const t of wanted) {
    const blocked = blockedSource(t.url);
    if (blocked) {
      detail.push({ id: t.id, ok: false, error: blocked });
      continue;
    }
    try {
      const html = await fetchPage(t.url);
      const got = extract(html);
      if (!got.description) {
        detail.push({ id: t.id, ok: false, error: "no description found", via: got.via });
        continue;
      }
      // comp_text only when we actually found one — never overwrite a real
      // value with null just because this page did not state pay.
      const patch: Record<string, unknown> = { description: got.description };
      if (got.comp_text) patch.comp_text = got.comp_text;
      const { error } = await admin.from("jobs").update(patch).eq("id", t.id);
      if (error) {
        detail.push({ id: t.id, ok: false, error: error.message });
        continue;
      }
      updated++;
      detail.push({
        id: t.id, ok: true, via: got.via,
        chars: got.description.length, comp_text: got.comp_text ?? null,
      });
    } catch (e) {
      detail.push({ id: t.id, ok: false, error: (e as Error).message });
    }
  }

  const report = { elapsed_ms: Date.now() - started, asked: wanted.length, updated, detail };
  await admin.from("runs").insert({
    kind: "describe", ok: updated === wanted.length, report,
  });
  return json({ ok: true, ...report });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
