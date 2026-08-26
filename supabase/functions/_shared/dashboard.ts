// The page Keith actually looks at.
//
// The old dashboard was an HTML file in the repo that asked him to paste a
// Supabase URL and an anon key into a form before it would show anything. That
// is precisely the kind of engineering chore the operating contract forbids,
// and it meant a machine running twice a day delivered to nobody.
//
// This renders server-side from a service-role connection, so the browser never
// receives a key and there is nothing to configure. Rendering is a pure
// function of the data so it can be tested without a database or a browser.

import { groupDuplicates, mergedLocation, representative } from "./dedupe.ts";

export interface ShortlistRow {
  job_id: number;
  company_id: number;
  fit_score: number | null;
  verdict: string | null;
  why_fits: string | null;
  why_not: string | null;
  resume_angle: string | null;
  title: string;
  location: string | null;
  url: string | null;
  comp_text: string | null;
  company: string | null;
  source: string | null;
  status: string | null;
  description?: string | null;
}

export interface RunRow {
  kind: string;
  ok: boolean;
  ran_at: string;
  report: Record<string, unknown> | null;
}

export interface Coverage {
  employers_total: number;
  employers_crawlable: number;
  employers_no_ats: number;
  open_jobs: number;
  sources: string[];
}

export interface PageData {
  rows: ShortlistRow[];
  runs: RunRow[];
  coverage: Coverage;
  /** ISO. Injected so the page is deterministic in tests. */
  now: string;
}

// ---- escaping --------------------------------------------------------------

/**
 * Job titles and descriptions are written by strangers and rendered into HTML.
 * Everything interpolated goes through here.
 */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Only http(s) survives. An earlier version of this dashboard would happily
 * render whatever was in the url column into an href, and a `javascript:` URL
 * from a posting is a scripted click away from doing whatever it likes with a
 * page that holds a live token.
 */
export function safeUrl(u: unknown): string | null {
  const s = String(u ?? "").trim();
  if (!s) return null;
  try {
    const p = new URL(s);
    return p.protocol === "http:" || p.protocol === "https:" ? p.toString() : null;
  } catch {
    return null;
  }
}

// ---- presentation helpers --------------------------------------------------

export function ago(then: string, now: string): string {
  const ms = new Date(now).getTime() - new Date(then).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  // floor, not round: rounding turns 30 seconds into "1 min ago", and the
  // sub-minute case is exactly the one worth saying "just now" about.
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** What a run actually did, in a sentence, from its own report. */
export function runSummary(r: RunRow): string {
  const rep = r.report ?? {};
  const n = (k: string) => Number(rep[k] ?? 0);
  switch (r.kind) {
    case "ingest":
      return `${n("companies_crawled")} employers checked, ${n("postings_seen")} ` +
        `postings kept, ${n("postings_below_level")} below level` +
        (n("companies_deferred_to_next_run")
          ? `, ${n("companies_deferred_to_next_run")} left for the next run`
          : "");
    case "score":
      return n("scored") === 0
        ? "nothing new to score"
        : `${n("scored")} scored` +
          (n("duplicates_collapsed") ? `, ${n("duplicates_collapsed")} duplicates` : "") +
          (n("failed") ? `, ${n("failed")} failed` : "");
    case "discover":
      return `${n("attempted")} employers looked up, ${n("ingestible_today")} newly crawlable, ` +
        `${n("still_unresolved")} still without a job board`;
    case "describe":
      return `${n("updated")} of ${n("asked")} descriptions fetched`;
    default:
      return r.ok ? "completed" : "failed";
  }
}

export interface Grouped {
  lead: ShortlistRow;
  ids: number[];
  location: string | null;
  copies: number;
}

/**
 * One job, once — however many rows it has.
 *
 * The scorer already refuses to PAY for a duplicate twice, but the rows are
 * still there: The Tile Shop's warehouse job holds six of them across five
 * stores. Six identical lines is how a five-item shortlist starts looking like
 * work.
 */
export function groupShortlist(rows: ShortlistRow[]): Grouped[] {
  // dedupe.ts keys on `id`; the shortlist calls it `job_id`. Aliasing here
  // rather than renaming either side keeps one definition of "the same job"
  // shared between what gets PAID for and what gets SHOWN — if those two ever
  // disagreed, the page would quietly contradict the bill.
  const keyed = rows.map((r) => ({ ...r, id: r.job_id }));
  return groupDuplicates(keyed).map((g) => ({
    lead: representative(g) as ShortlistRow,
    ids: g.map((r) => r.job_id),
    location: mergedLocation(g),
    copies: g.length,
  }));
}

// ---- the page --------------------------------------------------------------

const CSS = `
:root{--bg:#fbfaf9;--card:#fff;--ink:#1c1b19;--soft:#6b6862;--line:#e5e1dc;
--good:#1c6b3f;--warn:#8a5a00;--bad:#a32b2b;--accent:#1c4f8a}
@media (prefers-color-scheme:dark){:root{--bg:#17181a;--card:#1f2124;--ink:#eceae7;
--soft:#a09c96;--line:#33363a;--good:#5fd39a;--warn:#e0b25e;--bad:#f08a8a;--accent:#7fb2ee}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:920px;margin:0 auto;padding:24px 18px 64px}
h1{font-size:24px;margin:0 0 2px}
.sub{color:var(--soft);font-size:14px;margin-bottom:22px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;
padding:14px 16px;margin-bottom:18px}
.panel h2{font-size:13px;text-transform:uppercase;letter-spacing:.07em;
color:var(--soft);margin:0 0 10px;font-weight:600}
.run{display:flex;gap:10px;align-items:baseline;padding:5px 0;font-size:14px;
border-top:1px solid var(--line)}
.run:first-of-type{border-top:0}
.run b{min-width:74px;text-transform:capitalize}
.run .when{color:var(--soft);margin-left:auto;white-space:nowrap;font-size:13px}
.ok{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.job{background:var(--card);border:1px solid var(--line);border-radius:12px;
padding:16px;margin-bottom:12px}
.job.done{opacity:.5}
.jhead{display:flex;gap:12px;align-items:flex-start}
.score{font-size:26px;font-weight:700;line-height:1;min-width:44px;text-align:right}
.jtitle{font-size:17px;font-weight:600;margin:0}
.meta{color:var(--soft);font-size:14px;margin-top:2px}
.pay{color:var(--good);font-weight:600}
.why{margin-top:10px;font-size:14.5px}
.why b{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.06em;
color:var(--soft);margin-bottom:2px;font-weight:600}
.why p{margin:0 0 9px}
.angle{border-left:3px solid var(--accent);padding-left:11px}
.acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:13px;align-items:center}
a.btn,button{font:inherit;font-size:14px;padding:7px 13px;border-radius:8px;
border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer;
text-decoration:none;display:inline-block}
a.btn.primary{background:var(--accent);color:#fff;border-color:transparent}
button:hover{border-color:var(--soft)}
.tag{font-size:12px;color:var(--soft);border:1px solid var(--line);
border-radius:999px;padding:2px 9px}
.empty{color:var(--soft);font-size:14.5px}
.note{font-size:13.5px;color:var(--soft);margin:4px 0 0}
`;

const JS = `
async function mark(id, status, btn){
  const card = btn.closest('.job');
  const was = btn.textContent;
  btn.textContent = '...'; btn.disabled = true;
  try{
    const r = await fetch(location.pathname + location.search, {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({job_ids: JSON.parse(card.dataset.ids), status: status})
    });
    if(!r.ok) throw new Error(await r.text());
    card.classList.add('done');
    card.querySelector('.state').textContent = status;
  }catch(e){
    // Never leave a control that silently did nothing.
    btn.textContent = was; btn.disabled = false;
    alert('Could not save that: ' + e.message);
  }
}
`;

function card(g: Grouped): string {
  const r = g.lead;
  const link = safeUrl(r.url);
  const score = r.fit_score ?? 0;
  const tone = score >= 50 ? "ok" : score >= 38 ? "warn" : "";
  const done = r.status && r.status !== "new";
  const where = g.location ?? r.location ?? "not stated";
  return `
<div class="job ${done ? "done" : ""}" data-ids='${esc(JSON.stringify(g.ids))}'>
  <div class="jhead">
    <div class="score ${tone}">${esc(score)}</div>
    <div style="flex:1">
      <p class="jtitle">${esc(r.title)}</p>
      <div class="meta">${esc(r.company ?? "?")} &middot; ${esc(where)}${
    r.comp_text ? ` &middot; <span class="pay">${esc(r.comp_text)}</span>` : ""
  }</div>
    </div>
  </div>
  <div class="why">
    ${r.why_fits ? `<b>Why it fits</b><p>${esc(r.why_fits)}</p>` : ""}
    ${r.why_not ? `<b>The catch</b><p>${esc(r.why_not)}</p>` : ""}
    ${
    r.resume_angle
      ? `<div class="angle"><b>Lead with</b><p>${esc(r.resume_angle)}</p></div>`
      : ""
  }
  </div>
  <div class="acts">
    ${link ? `<a class="btn primary" href="${esc(link)}" target="_blank" rel="noopener">Open posting</a>` : ""}
    <button onclick="mark(0,'applied',this)">Applied</button>
    <button onclick="mark(0,'dismissed',this)">Not interested</button>
    <span class="tag state">${esc(r.status ?? "new")}</span>
    ${g.copies > 1 ? `<span class="tag">${g.copies} listings</span>` : ""}
    <span class="tag">${esc(r.source ?? "?")}</span>
  </div>
</div>`;
}

/**
 * The whole page.
 *
 * Principle 10 applies here more than anywhere: a panel with no real data says
 * so and says why. An empty shortlist that explains itself beats a green one
 * that lies.
 */
export function renderPage(d: PageData): string {
  const groups = groupShortlist(d.rows);
  const live = groups.filter((g) => !g.lead.status || g.lead.status === "new");
  const handled = groups.length - live.length;

  const runs = ["ingest", "score", "discover"]
    .map((k) => d.runs.find((r) => r.kind === k))
    .filter(Boolean) as RunRow[];

  const stale = (r: RunRow) =>
    new Date(d.now).getTime() - new Date(r.ran_at).getTime() > 36 * 3600 * 1000;

  const statusRows = runs.length
    ? runs.map((r) =>
      `<div class="run"><b>${esc(r.kind)}</b>
       <span class="${r.ok ? "ok" : "bad"}">${r.ok ? "ok" : "failed"}</span>
       <span>${esc(runSummary(r))}</span>
       <span class="when ${stale(r) ? "warn" : ""}">${esc(ago(r.ran_at, d.now))}</span></div>`
    ).join("")
    : `<p class="empty">Nothing has run yet. That is not a display problem —
       no crawl or scoring run has been recorded.</p>`;

  const cov = d.coverage;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JobScout</title><style>${CSS}</style></head><body><div class="wrap">

<h1>JobScout</h1>
<p class="sub">${live.length} live opportunit${live.length === 1 ? "y" : "ies"}${
    handled ? ` &middot; ${handled} handled` : ""
  } &middot; checked twice a day</p>

<div class="panel">
  <h2>The machine</h2>
  ${statusRows}
</div>

${
    live.length
      ? live.map((g) => card(g)).join("")
      : `<div class="panel"><p class="empty">No open opportunities right now.
         The crawl and the scorer both ran — there is simply nothing new at the
         employers being watched. This is a real result, not a blank screen.</p></div>`
  }

${handled ? `<div class="panel"><h2>Handled</h2>${
    groups.filter((g) => g.lead.status && g.lead.status !== "new")
      .map((g) => card(g)).join("")
  }</div>` : ""}

<div class="panel">
  <h2>What this does not cover</h2>
  <p class="note">Watching <b>${cov.employers_crawlable}</b> employers with a
  readable job board, out of <b>${cov.employers_total}</b> on the target list.
  <b>${cov.employers_no_ats}</b> have no job board we can read — their openings
  will not appear here at all.</p>
  <p class="note">Sources feeding this: ${
    cov.sources.length ? esc(cov.sources.join(", ")) : "none"
  }. Alert emails are loaded by hand, not automatically.</p>
</div>

</div><script>${JS}</script></body></html>`;
}
