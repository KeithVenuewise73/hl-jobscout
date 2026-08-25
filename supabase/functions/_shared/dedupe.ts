// One job, posted many times.
//
// Three shapes of duplicate, all observed on live data:
//
//   * The same job from two SOURCES — New Era Cap's "Manager, Logistics
//     (North America)" arrived once from a LinkedIn alert with no description
//     and once from ADP with a description and a salary. Scored twice: 54 and
//     56.
//   * One job posted per LOCATION — The Tile Shop's "Warehouse Manager" ran to
//     six rows across five stores, Epiq's "Senior Director, AI Programmatic
//     Sales" to four.
//   * The same posting listed twice by one board, for the same city.
//
// Every copy costs a model call and clutters the shortlist with a job already
// judged.
//
// EQUALITY IS NOT ENOUGH, and this is the part worth knowing: those six Tile
// Shop rows carried FIVE distinct descriptions. Same template, small edits —
// some open "The Tile Shop is NOW HIRING...", others "The In-Store Warehouse
// Manager is responsible for...". Hashing the text, however carefully
// normalized, collapses none of them. Near-duplicate detection is the only
// thing that works.

export interface DupJob {
  id: number;
  company_id: number;
  title: string;
  location?: string | null;
  description?: string | null;
  comp_text?: string | null;
}

/** Case, punctuation and spacing carry no meaning in a job title. */
export const normTitle = (t: string): string =>
  (t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Overlapping 3-word shingles.
 *
 * Single words would match on boilerplate alone — every posting at one employer
 * shares its benefits and EEO paragraphs. Three-word runs capture phrasing, so
 * two genuinely different jobs stay apart even when half the page is identical.
 */
export function shingles(text: string, n = 3): Set<string> {
  const w = (text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ")
    .filter(Boolean);
  const out = new Set<string>();
  if (w.length < n) {
    if (w.length) out.add(w.join(" "));
    return out;
  }
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

/** Jaccard overlap of two shingle sets: 1 identical, 0 nothing in common. */
export function similarity(a: string, b: string): number {
  const A = shingles(a), B = shingles(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const s of A) if (B.has(s)) shared++;
  return shared / (A.size + B.size - shared);
}

/**
 * Two postings are the same job when they share an employer AND an exact
 * normalized title AND their descriptions are near-identical — or one of them
 * has no description at all to disagree with.
 *
 * Requiring the identical title is the real guard. Two different roles that
 * share a title at one employer are almost always the same role at different
 * sites; the similarity check is there for the rarer case where they are not,
 * so a "Operations Manager" in two divisions with genuinely different duties
 * stays two rows.
 *
 * When in doubt this SPLITS. A wrong split costs a model call; a wrong merge
 * hides a job.
 */
export const SIMILAR_ENOUGH = 0.6;

export function sameJob(a: DupJob, b: DupJob): boolean {
  if (a.company_id !== b.company_id) return false;
  if (normTitle(a.title) !== normTitle(b.title)) return false;
  const da = a.description ?? "", db = b.description ?? "";
  // A description-less row is the same opportunity seen with less information,
  // not a different one — that is exactly the cross-source case.
  if (!da || !db) return true;
  return similarity(da, db) >= SIMILAR_ENOUGH;
}

/**
 * The copy worth scoring: the one carrying the most information, because its
 * verdict is the one every other copy inherits.
 */
export function representative<T extends DupJob>(group: T[]): T {
  return [...group].sort((x, y) => {
    const d = (y.description?.length ?? 0) - (x.description?.length ?? 0);
    if (d) return d;
    const c = (y.comp_text ? 1 : 0) - (x.comp_text ? 1 : 0);
    if (c) return c;
    return x.id - y.id; // stable
  })[0];
}

/**
 * Every location the group was posted in, deduplicated and in order.
 *
 * This matters more than it looks. The Tile Shop's five stores are Littleton
 * CO, Denver CO, Colonie NY, Cheektowaga NY and Avon MA. Scoring one copy and
 * copying its verdict would judge the job on ONE of those — pick the Colorado
 * row and a Buffalo-commutable job reads as a relocation. Handing the model
 * every location in one call lets it say "in range at Cheektowaga" once.
 */
export function mergedLocation(group: DupJob[]): string | null {
  const seen: string[] = [];
  for (const j of group) {
    const l = (j.location ?? "").trim();
    if (l && !seen.includes(l)) seen.push(l);
  }
  if (!seen.length) return null;
  if (seen.length === 1) return seen[0];
  return `${seen.join("; ")} (${seen.length} locations)`;
}

/** Partition into groups of the same job. Order within a group is preserved. */
export function groupDuplicates<T extends DupJob>(jobs: T[]): T[][] {
  const groups: T[][] = [];
  for (const j of jobs) {
    // Compare against the group's representative rather than any member, so a
    // chain of drifting near-matches cannot merge two clearly-different jobs.
    const hit = groups.find((g) => sameJob(representative(g), j));
    if (hit) hit.push(j);
    else groups.push([j]);
  }
  return groups;
}
