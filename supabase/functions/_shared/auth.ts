// Who is allowed to start a run.
//
// Every JobScout function sits behind verify_jwt, which is necessary and not
// sufficient: the project's ANON key is a valid JWT and is public by design.
// Anyone holding it could trigger a scoring run, and a scoring run spends real
// money — so a second factor is required.
//
// The second factor is a token the DATABASE mints (migration 0006). pg_cron
// reads it to build the header; the function reads it back over the
// service-role connection it already has. It is never printed, never pasted
// into a dashboard, and never leaves the project.

export const CRON_HEADER = "x-jobscout-token";

export interface TokenStore {
  /** Returns the expected token, or null if none is configured. */
  expected(): Promise<string | null>;
}

/**
 * Constant-time-ish comparison. Not a defence against a local attacker with a
 * stopwatch — that is not the threat here — but there is no reason to leak the
 * prefix length to someone probing over the internet either.
 */
export function tokenMatches(given: string | null, expected: string | null): boolean {
  if (!expected || !given) return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export interface AuthResult {
  ok: boolean;
  /** Why it was refused, for the response body. Never echoes the token. */
  reason?: string;
}

/**
 * OPEN BY DEFAULT WHEN NOTHING IS CONFIGURED, and deliberately so.
 *
 * The token lives in a table created by the schedule migration. Until that
 * migration is applied there is no token to check, and refusing every request
 * would take the whole tool offline the moment this shipped — a guard that
 * breaks the thing it protects gets deleted, not fixed. Once the row exists
 * the check is mandatory, so applying the migration is what arms it.
 */
export async function authorize(req: Request, store: TokenStore): Promise<AuthResult> {
  let expected: string | null;
  try {
    expected = await store.expected();
  } catch (e) {
    // A database that cannot answer must not be read as permission.
    return { ok: false, reason: `could not read the run token: ${(e as Error).message}` };
  }
  if (!expected) return { ok: true };

  const given = req.headers.get(CRON_HEADER);
  if (!given) {
    return {
      ok: false,
      reason: `missing ${CRON_HEADER}. This function is scheduled; a valid JWT ` +
        `alone is not enough to start a run, because the anon key is public.`,
    };
  }
  if (!tokenMatches(given, expected)) return { ok: false, reason: `bad ${CRON_HEADER}` };
  return { ok: true };
}
