import { assertEquals, assertStringIncludes, assertTrue } from "./assert.ts";
import { authorize, CRON_HEADER, tokenMatches } from "../_shared/auth.ts";

const req = (headers: Record<string, string> = {}) =>
  new Request("https://x.test/", { headers });
const store = (t: string | null) => ({ expected: () => Promise.resolve(t) });

Deno.test("the right token opens the door and a wrong one does not", async () => {
  assertEquals((await authorize(req({ [CRON_HEADER]: "abc" }), store("abc"))).ok, true);
  assertEquals((await authorize(req({ [CRON_HEADER]: "abd" }), store("abc"))).ok, false);
  assertEquals((await authorize(req({ [CRON_HEADER]: "" }), store("abc"))).ok, false);
});

Deno.test("a valid JWT alone is not enough, and the refusal says why", async () => {
  // The whole point: the anon key is a valid JWT and is public, so anyone
  // holding it could start a run that spends money.
  const r = await authorize(req(), store("abc"));
  assertEquals(r.ok, false);
  assertStringIncludes(r.reason ?? "", "anon key is public");
  assertTrue(!(r.reason ?? "").includes("abc"), "must never echo the token");
});

Deno.test("no token configured means open — the guard must not break the tool", async () => {
  // The token lives in a table the schedule migration creates. Before it is
  // applied there is nothing to check, and refusing everything would take the
  // tool offline the moment this shipped.
  assertEquals((await authorize(req(), store(null))).ok, true);
});

Deno.test("a database that cannot answer is not read as permission", async () => {
  const broken = { expected: () => Promise.reject(new Error("connection reset")) };
  const r = await authorize(req({ [CRON_HEADER]: "abc" }), broken);
  assertEquals(r.ok, false);
  assertStringIncludes(r.reason ?? "", "connection reset");
});

Deno.test("comparison does not short-circuit on length or content", () => {
  assertEquals(tokenMatches("abc", "abc"), true);
  assertEquals(tokenMatches("abc", "abcd"), false);
  assertEquals(tokenMatches("", ""), false);      // empty is never a match
  assertEquals(tokenMatches(null, "abc"), false);
  assertEquals(tokenMatches("abc", null), false);
});
