// Tailoring a resume to one posting, and writing the letter that goes with it.
//
// THE ONLY HARD PART IS NOT WRITING. IT IS NOT LYING.
//
// A model told to "tailor this resume to this job" drifts toward invention. It
// adds a skill the posting asked for, upgrades a title, or manufactures a
// number — "increased productivity 312%" is the canonical example, and it is
// the kind of line that survives the screen and then collapses in the
// interview, or worse, after the hire. A resume is a document someone signs
// their name to. Fabrication here is not a quality bug, it is a liability.
//
// So the contract is: the model may REORDER, REWORD and SELECT. It may not
// ADD. And that is not enforced by asking nicely — every bullet it writes must
// name the verbatim line of the resume it came from, and verifyGrounded()
// checks the claim mechanically afterwards. A bullet whose source is not in
// the resume, or which carries a number the resume never states, does not get
// shipped. It gets reported.
//
// Everything here is pure. The model call is injected, so the prompt contract,
// the verification and the fallback are all testable without spending a token.

import type { Company, Job, Resume, Usage, Verdict } from "./score.ts";

export const MODEL = "claude-opus-5";

export interface TailoredBullet {
  /** The rewritten line. */
  text: string;
  /** The line from the resume it was derived from, quoted verbatim. */
  source: string;
  /** Which employer or section of the resume it belongs under. */
  section: string;
}

export interface Tailored {
  /** Professional summary, rewritten to lead with what this job cares about. */
  headline: string;
  bullets: TailoredBullet[];
  /** Selected from the resume, never invented. */
  skills: string[];
  cover_letter: string;
  /** What was deliberately left out of this version, and why. */
  omitted: string;
}

export interface Finding {
  kind: "source_not_in_resume" | "unsupported_number";
  /** Index into bullets, or -1 for the cover letter. */
  where: number;
  detail: string;
}

// ---- the prompt ------------------------------------------------------------

export const SYSTEM = `You rewrite one candidate's existing resume so it leads \
with what a specific job actually needs, and you draft the cover letter to go \
with it.

THE ABSOLUTE RULE, WHICH OVERRIDES EVERY OTHER INSTRUCTION HERE:

You may REORDER, REWORD, EMPHASISE and OMIT. You may NEVER ADD. Every claim in
your output must already be true according to the resume you are given. You do
not have any other source of information about this candidate.

Specifically, you must never:
- state a number, percentage, headcount, budget or dollar figure that does not
  appear in the resume — not even a rounded or "conservative" one;
- name a tool, system, certification, employer or degree the resume does not name;
- upgrade a job title, or describe a scope larger than the resume describes;
- write that he "has experience with" something because the posting asks for it.

If the posting wants something he does not have, the honest move is to leave it
out and lead with what he does have. Say what you left out, and why, in
'omitted'. That field is for the candidate's eyes only — it never goes to the
employer — so be direct about the gaps.

HOW TO WRITE THE BULLETS

For every bullet you produce, quote in 'source' the line from the resume it came
from, EXACTLY as it appears there — same words, same numbers, copied not
paraphrased. This is checked automatically. A bullet whose source cannot be
found in the resume is discarded, so an approximate quote costs you the bullet.

Rewriting means changing emphasis and language, not facts. If the resume says
"managed a team of 12" you may write "led a 12-person team" — you may not write
"led a team of 15" or "led a large team" if that overstates it.

Every number in a bullet must appear in the line you cite as its source. The
check is against THAT LINE, not the resume as a whole, because a figure lifted
from one line and attached to the subject of another is a false claim built
from true parts. If you want to combine facts from two lines, write two
bullets.

Choose the 8 to 14 bullets that matter most for THIS posting, ordered with the
most relevant first. A shorter resume that lands is better than a complete one
that buries the point.

FORMATTING

Plain language. No buzzwords, no "results-driven professional". The output is
parsed by applicant tracking software before a human sees it, so keep bullets to
one or two lines and avoid clever phrasing.

THE COVER LETTER

Three or four short paragraphs, addressed to the employer by name. Open with the
single most relevant thing he has actually done — not with "I am writing to
apply". Say why this employer specifically. Close plainly.

The same rule applies: every fact in the letter comes from the resume. No
numbers the resume does not state.`;

export const SCHEMA = {
  type: "object",
  properties: {
    headline: {
      type: "string",
      description:
        "Two or three sentences. His actual background, angled at this job.",
    },
    bullets: {
      type: "array",
      description: "8 to 14 bullets, most relevant to this posting first.",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "The rewritten bullet." },
          source: {
            type: "string",
            description:
              "The line from the resume this came from, copied verbatim.",
          },
          section: {
            type: "string",
            description: "The employer or resume section this belongs under.",
          },
        },
        required: ["text", "source", "section"],
        additionalProperties: false,
      },
    },
    skills: {
      type: "array",
      description: "Skills drawn from the resume, ordered by relevance here.",
      items: { type: "string" },
    },
    cover_letter: { type: "string" },
    omitted: {
      type: "string",
      description:
        "What this posting asks for that he does not have, and what you left out. For his eyes only.",
    },
  },
  required: ["headline", "bullets", "skills", "cover_letter", "omitted"],
  additionalProperties: false,
} as const;

/**
 * The cached half: the resume, byte-identical across every posting he tailors
 * for. Tailoring ten jobs pays for the resume once.
 */
export function resumeBlock(r: Resume): string {
  return ["CANDIDATE RESUME", "", r.content].join("\n");
}

/** The volatile half: this posting, plus what the scorer already concluded. */
export function jobBlock(job: Job, co: Company, verdict?: Verdict): string {
  const angle = verdict?.resume_angle?.trim();
  return [
    "---",
    `EMPLOYER: ${co.name ?? "?"}${co.city ? ` — ${co.city}, ${co.state ?? ""}` : ""}`,
    `ROLE: ${job.title}`,
    `LOCATION: ${job.location || "not stated"}`,
    `STATED PAY: ${job.comp_text || "not stated"}`,
    "",
    "POSTING:",
    job.description || "(no description available — work from the title only)",
    ...(angle
      // The scorer already read this posting against this resume and said what
      // to lead with. Re-deriving it would be paying twice for the same thought.
      ? ["", `THE ANGLE ALREADY IDENTIFIED FOR THIS JOB: ${angle}`]
      : []),
  ].join("\n");
}

// ---- verification ----------------------------------------------------------
//
// This is the part that makes the promise real.

/** Case, punctuation and spacing carry no meaning when checking a quote. */
export function norm(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[‘’“”]/g, "'") // smart quotes are still quotes
    .replace(/[^a-z0-9$%.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

/** Reverse of WORD_NUMBERS, so a digit can find its spelled-out twin. */
const WORD_FOR: Record<string, string> = Object.fromEntries(
  Object.entries(WORD_NUMBERS).map(([w, n]) => [String(n), w]),
);

const MAGNITUDE: Record<string, number> = {
  k: 1_000, thousand: 1_000, m: 1_000_000, mm: 1_000_000, million: 1_000_000,
  b: 1_000_000_000, billion: 1_000_000_000,
};

/**
 * Every numeric claim in a piece of text, canonicalised.
 *
 * THE UNIT IS PART OF THE CLAIM, and getting this wrong is how a fabrication
 * walks through. An early version canonicalised "$12M" to the bare digits
 * "12", which the test resume happened to contain — it says "a team of 12" —
 * so an invented twelve-million-dollar budget verified clean against a
 * twelve-person team. A percentage, a dollar figure and a headcount that share
 * a digit are not the same fact.
 *
 * So "$4.2M" canonicalises to 4200000, and matches a resume that writes the
 * same figure as "$4,200,000" — the same claim in different clothes, which is
 * what rewording is allowed to do. Bare counts additionally match their
 * spelled-out form, because "a team of twelve" and "a team of 12" are one
 * claim and rejecting that would send him back to editing by hand.
 */
export function numbersIn(text: string): string[][] {
  const out: string[][] = [];
  const src = (text ?? "").toLowerCase();

  // The word boundary belongs to the WORD suffixes only. A trailing \b after
  // the whole group silently swallowed every percent sign: "%" is not a word
  // character, so "40%." had no boundary after it, the group backtracked to
  // empty, and a percentage canonicalised to a bare count.
  const re =
    /(\d[\d,]*(?:\.\d+)?)\s*(%|percent\b|k\b|mm\b|m\b|b\b|thousand\b|million\b|billion\b)?/g;
  for (const m of src.matchAll(re)) {
    const bare = m[1].replace(/,/g, "");
    const suffix = m[2];
    if (suffix === "%" || suffix === "percent") {
      out.push([`${bare}%`]);
    } else if (suffix && MAGNITUDE[suffix]) {
      const scaled = Number(bare) * MAGNITUDE[suffix];
      const forms = [`${bare}${suffix}`];
      if (Number.isFinite(scaled)) forms.unshift(String(Math.round(scaled)));
      out.push(forms);
    } else {
      const word = WORD_FOR[bare];
      out.push(word ? [bare, word] : [bare]);
    }
  }

  // A resume that spells a number out states it just as plainly.
  for (const [word, n] of Object.entries(WORD_NUMBERS)) {
    if (new RegExp(`\\b${word}\\b`).test(src)) out.push([String(n), word]);
  }
  return out;
}

/** Everything the resume actually states, in every form. */
export function numberSet(resume: string): Set<string> {
  const set = new Set<string>();
  for (const forms of numbersIn(resume)) for (const f of forms) set.add(f);
  return set;
}

/**
 * Check the model's work against the resume it was given.
 *
 * Two questions, both mechanical:
 *   1. Is the quoted source really in the resume?
 *   2. Does every number in the output appear in the resume?
 *
 * It does not check style, or whether the rewrite is any good. It checks
 * whether anything was invented, which is the only failure that matters.
 */
export function verifyGrounded(resumeText: string, t: Tailored): Finding[] {
  const findings: Finding[] = [];
  const haystack = norm(resumeText);
  const known = numberSet(resumeText);

  /** Numbers in `text` that the given evidence does not state. */
  const unsupportedIn = (text: string, evidence: string): string[] => {
    const set = numberSet(evidence);
    return numbersIn(text)
      // Matching is set membership on canonical forms, never substring: "12"
      // must not be satisfied by the "12" inside "2012", and a dollar figure
      // must not be satisfied by a headcount that shares its digits.
      .filter((forms) => !forms.some((f) => set.has(f)))
      .map((forms) => forms[0]);
  };

  // The headline and the letter cite no single line, so the whole resume is
  // the only evidence available for them.
  const unsupported = (text: string): string[] =>
    numbersIn(text)
      // Matching is set membership on canonical forms, never substring: "12"
      // must not be satisfied by the "12" inside "2012", and a dollar figure
      // must not be satisfied by a headcount that shares its digits.
      .filter((forms) => !forms.some((f) => known.has(f)))
      .map((forms) => forms[0]);

  t.bullets.forEach((b, i) => {
    if (!haystack.includes(norm(b.source))) {
      findings.push({
        kind: "source_not_in_resume",
        where: i,
        detail: `quoted source is not in the resume: "${b.source.slice(0, 90)}"`,
      });
    }
    // A NUMBER IN A BULLET IS CHECKED AGAINST THAT BULLET'S OWN SOURCE LINE,
    // not against the whole resume.
    //
    // Checking the whole resume binds a figure to nothing but its digits. This
    // resume says "approximately 98% on-time off-dock performance" and, on a
    // different line, "80 drivers". Against the whole document, a bullet
    // claiming "98% of the fleet" or "an 80% improvement" verifies clean —
    // right numbers, invented subjects. The bullet already has to name the
    // line it came from, so that line is the honest place to check it.
    //
    // Bullets that legitimately draw a number from a different part of the
    // resume are the cost, and it is the right cost: an over-strict check
    // deletes a true bullet, an under-strict one ships a false claim.
    for (const n of unsupportedIn(b.text, b.source)) {
      findings.push({
        kind: "unsupported_number",
        where: i,
        detail: `"${n}" is not in the resume line this bullet cites`,
      });
    }
  });

  // The headline and the skills carry no numbers worth trusting either.
  for (const n of unsupported(t.headline)) {
    findings.push({
      kind: "unsupported_number",
      where: -1,
      detail: `headline states "${n}", which is not in the resume`,
    });
  }
  for (const n of unsupported(t.cover_letter)) {
    findings.push({
      kind: "unsupported_number",
      where: -1,
      detail: `cover letter states "${n}", which is not in the resume`,
    });
  }
  return findings;
}

export interface Checked {
  clean: Tailored;
  /** Bullets that failed verification. Reported, never silently dropped. */
  removed: { bullet: TailoredBullet; why: string }[];
  /** Problems in the headline or letter, which cannot simply be deleted. */
  document: Finding[];
}

/**
 * Remove what could not be verified.
 *
 * A bad bullet is deletable — the resume is shorter and still true. A bad
 * headline or letter is not: cutting a sentence out of a letter leaves a hole.
 * Those come back as `document` findings for the caller to act on, which is
 * what drives the one retry in runTailor.
 */
export function sanitize(resumeText: string, t: Tailored): Checked {
  const findings = verifyGrounded(resumeText, t);
  const bad = new Map<number, string>();
  const document: Finding[] = [];
  for (const f of findings) {
    if (f.where < 0) document.push(f);
    else bad.set(f.where, [bad.get(f.where), f.detail].filter(Boolean).join("; "));
  }
  const removed = [...bad.entries()].map(([i, why]) => ({
    bullet: t.bullets[i],
    why,
  }));
  return {
    clean: { ...t, bullets: t.bullets.filter((_, i) => !bad.has(i)) },
    removed,
    document,
  };
}

// ---- the run ---------------------------------------------------------------

export type AskTailor = (
  resume: string,
  posting: string,
  correction?: string,
) => Promise<{ tailored: Tailored; usage: Usage }>;

export interface TailorReport {
  ok: boolean;
  bullets_kept: number;
  bullets_removed: { text: string; why: string }[];
  document_findings: string[];
  retried: boolean;
  /**
   * What the FIRST attempt tried to claim, when there was a retry.
   *
   * Without this the report says "retried: true" and nothing else, which is
   * the guard reporting that it fired while withholding what it caught. On the
   * first live run that is exactly what happened, and the invented claim was
   * lost. What the model reached for is the most interesting thing here.
   */
  first_attempt_rejected?: string[];
  usage: Usage;
}

export interface TailorDeps {
  resume: Resume;
  job: Job;
  company: Company;
  verdict?: Verdict;
  ask: AskTailor;
}

/**
 * Generate, check, and — if the model invented something — tell it exactly what
 * and ask once more.
 *
 * One retry, not a loop. If naming the specific fabricated figure does not fix
 * it, more attempts will not either, and each one costs money. What comes back
 * from a failed second attempt is still returned, with the problems attached:
 * a tailoring that says "these three bullets could not be verified" is useful.
 * One that quietly shipped them is the thing this whole file exists to prevent.
 */
export async function runTailor(
  deps: TailorDeps,
): Promise<{ result: Checked; report: TailorReport }> {
  const resumeText = deps.resume.content;
  const prefix = resumeBlock(deps.resume);
  const posting = jobBlock(deps.job, deps.company, deps.verdict);

  const usage: Usage = { input: 0, cached: 0, output: 0 };
  const add = (u: Usage) => {
    usage.input += u.input;
    usage.cached += u.cached;
    usage.output += u.output;
  };

  const first = await deps.ask(prefix, posting);
  add(first.usage);
  let checked = sanitize(resumeText, first.tailored);
  let retried = false;
  let firstRejected: string[] | undefined;

  if (checked.removed.length || checked.document.length) {
    retried = true;
    firstRejected = [
      ...checked.removed.map((r) => `${r.why} — in "${r.bullet.text.slice(0, 70)}"`),
      ...checked.document.map((f) => f.detail),
    ];
    const second = await deps.ask(prefix, posting, correctionFor(checked));
    add(second.usage);
    const recheck = sanitize(resumeText, second.tailored);
    // Keep whichever attempt survived verification better. A second try that
    // invented MORE is not an improvement just because it came later.
    const score = (c: Checked) => c.clean.bullets.length - c.document.length * 3;
    if (score(recheck) >= score(checked)) checked = recheck;
  }

  return {
    result: checked,
    report: {
      ok: checked.document.length === 0,
      bullets_kept: checked.clean.bullets.length,
      bullets_removed: checked.removed.map((r) => ({
        text: r.bullet.text,
        why: r.why,
      })),
      document_findings: checked.document.map((f) => f.detail),
      retried,
      ...(firstRejected ? { first_attempt_rejected: firstRejected } : {}),
      usage,
    },
  };
}

/** What to tell the model about its own invention, specifically. */
export function correctionFor(c: Checked): string {
  const lines = [
    "Your previous attempt did not pass verification. Every problem below is a",
    "claim that is NOT in the resume you were given. Write the whole thing",
    "again without them. Do not substitute a different number — remove the",
    "claim, or make the point without a figure.",
    "",
  ];
  for (const r of c.removed) {
    lines.push(`- Bullet "${r.bullet.text.slice(0, 80)}": ${r.why}`);
  }
  for (const f of c.document) lines.push(`- ${f.detail}`);
  lines.push(
    "",
    "Remember: 'source' must be copied from the resume character for character.",
  );
  return lines.join("\n");
}

// ---- output ----------------------------------------------------------------

/**
 * Plain text, because plain text is what applicant tracking systems parse
 * without complaint.
 *
 * Every published guide on ATS parsing says the same thing: columns, tables,
 * text boxes, headers and graphics are where resumes get mangled or dropped.
 * A single column of short lines with obvious section headings is the format
 * that survives, and it is also the one he can paste into the "paste your
 * resume" box that half of these systems offer.
 */
export function renderResume(
  r: Resume,
  t: Tailored,
  job: Job,
  co: Company,
): string {
  const bySection = new Map<string, string[]>();
  for (const b of t.bullets) {
    const k = b.section || "EXPERIENCE";
    if (!bySection.has(k)) bySection.set(k, []);
    bySection.get(k)!.push(b.text);
  }

  const out: string[] = [
    `Tailored for: ${job.title} — ${co.name ?? "?"}`,
    "",
    "SUMMARY",
    t.headline,
    "",
  ];
  if (t.skills.length) {
    out.push("SKILLS", t.skills.join(" · "), "");
  }
  out.push("EXPERIENCE");
  for (const [section, bullets] of bySection) {
    out.push("", section);
    for (const b of bullets) out.push(`- ${b}`);
  }
  out.push("", `[Based on ${r.label}. No claim here is absent from that resume.]`);
  return out.join("\n");
}

export function renderLetter(t: Tailored): string {
  return t.cover_letter.trim();
}
