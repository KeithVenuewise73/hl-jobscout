# jobscout-viewer

Serves the JobScout shortlist on a domain that will render HTML.

## Why this exists

Supabase will not serve a web page. Every response from `*.supabase.co` comes
back rewritten:

```
content-type: text/plain
x-content-type-options: nosniff
content-security-policy: default-src 'none'; sandbox
```

Measured on this project, against the identical file, on all three paths that
could plausibly have behaved differently:

| Path | Result |
|---|---|
| `/functions/v1/jobscout-dashboard` | clamped |
| `/storage/v1/object/public/dash/...` | clamped |
| `/storage/v1/object/sign/dash/...?token=` | clamped |

It is a policy, not a bug: that domain is shared by every Supabase project, and
letting anyone host HTML on it would be an XSS vector against all of them.
`nosniff` is what seals it — the browser is told not to guess.

So the page is rendered and stored by Supabase, and served to a browser from
Keith's own server, where his own domain sets the rules.

## What it does

Three routes, and no logic beyond them:

| | |
|---|---|
| `GET /?k=<token>` | fetch the page from Supabase, hand it back as `text/html` |
| `POST /?k=<token>` | forward an Applied / Not interested click |
| `GET /health` | `200 ok`, without touching Supabase |

Supabase still decides everything: whether the token is valid, what the page
says, what a click is allowed to write.

## It holds no secrets

There is one environment variable and it is not a credential:

```
JOBSCOUT_UPSTREAM = https://<project>.supabase.co/functions/v1/jobscout-dashboard
```

The view token arrives in the query string from the bookmark and is passed
straight through. A server that stores no credential cannot leak one.

Two things it does set, and both matter:

- **`referrer-policy: no-referrer`** — the page's own URL carries the view
  token, and every "Open posting" link goes to a stranger's website. Without
  this, the token is handed to each of them in the `Referer` header.
- **A bad token stays a bare `404`.** Rendering a friendly error page would
  confirm to whoever is probing that the address is real.

## Deploying

Docker, port 8000, health check on `/health`. The image is `deno:alpine` plus
two files; there is nothing to install and `deno check` runs at build time, so
a syntax error fails the build rather than the first page load.

## Tests

`supabase/functions/tests/viewer_test.ts`, run with the rest of the suite. They
cover the parts worth covering: that a crafted token cannot bolt a second query
parameter onto the upstream URL or redirect it to another host, that the page
comes back as HTML, that the referrer policy is set, and that a rejected token
is not dressed up.
