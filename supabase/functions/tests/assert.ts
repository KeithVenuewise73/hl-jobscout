// node:assert is a Deno builtin — no registry fetch, so the suite runs in any
// sandbox (including one with no outbound network at all).
//
// deepStrictEqual, not strictEqual: half these assertions compare arrays, and
// reference equality passes them vacuously.
import { deepStrictEqual, match, ok } from "node:assert/strict";

export function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  deepStrictEqual(actual, expected, msg);
}

export function assertTrue(value: unknown, msg?: string): void {
  ok(value, msg);
}

export function assertStringIncludes(haystack: string, needle: string): void {
  match(haystack, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
