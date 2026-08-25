// SSRF guard. Board tokens and workday hosts are DATA out of the companies
// table, and this code runs server-side on Supabase's network — so a bad row
// must not turn into a request to the cloud metadata endpoint.

import { assertEquals, assertTrue } from "./assert.ts";
import { ipBlockedReason, resolveAndValidate, SsrfError, validateUrl } from "../_shared/url.ts";

const blocked = (u: string) => {
  try {
    validateUrl(u);
    return null;
  } catch (e) {
    return e instanceof SsrfError ? e.reason : `unexpected:${(e as Error).name}`;
  }
};

Deno.test("private, loopback and metadata addresses are refused", () => {
  assertTrue(blocked("http://127.0.0.1/x"), "loopback");
  assertTrue(blocked("http://10.0.0.5/x"), "private 10/8");
  assertTrue(blocked("http://192.168.1.1/x"), "private 192.168/16");
  assertTrue(blocked("http://172.16.0.1/x"), "private 172.16/12");
  assertTrue(blocked("http://169.254.169.254/latest/meta-data/"), "cloud metadata");
  assertTrue(blocked("http://localhost/x"), "localhost");
  assertTrue(blocked("http://db.internal/x"), "internal tld");
});

Deno.test("non-http schemes are refused", () => {
  assertTrue(blocked("file:///etc/passwd"));
  assertTrue(blocked("gopher://x/1"));
});

Deno.test("real board endpoints pass", () => {
  assertEquals(blocked("https://boards-api.greenhouse.io/v1/boards/acme/jobs"), null);
  assertEquals(blocked("https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External/jobs"), null);
});

Deno.test("ipBlockedReason classifies the ranges that matter", () => {
  assertEquals(ipBlockedReason("169.254.169.254"), "link_local");
  assertEquals(ipBlockedReason("127.0.0.1"), "loopback");
  assertEquals(ipBlockedReason("10.1.2.3"), "private");
  assertEquals(ipBlockedReason("52.1.2.3"), null);
});

Deno.test("DNS rebinding is caught — a public name resolving inward is refused", async () => {
  const resolve = () => Promise.resolve(["169.254.169.254"]);
  let reason: string | null = null;
  try {
    await resolveAndValidate("totally-normal.example.com", resolve);
  } catch (e) {
    reason = (e as SsrfError).reason;
  }
  assertEquals(reason, "dns_link_local");
});

Deno.test("a name with no DNS records is refused rather than attempted", async () => {
  let reason: string | null = null;
  try {
    await resolveAndValidate("nope.example.com", () => Promise.resolve([]));
  } catch (e) {
    reason = (e as SsrfError).reason;
  }
  assertEquals(reason, "dns_no_records");
});
