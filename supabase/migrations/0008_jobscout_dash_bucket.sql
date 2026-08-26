-- ============================================================
-- JobScout — the bucket the shortlist page is written to.
--
-- The page is a FILE, not a response. An edge function cannot serve HTML on
-- the shared supabase.co domain: the platform rewrites the response to
-- text/plain with nosniff and a sandbox CSP, and the browser shows source
-- code. Measured on this project, the same clamp applies to
-- /functions/v1/..., /storage/v1/object/public/... and a signed
-- /storage/v1/object/sign/... URL alike — so this bucket does not by itself
-- make the page render. It makes the page a file, which is what any host that
-- CAN render it will need.
--
-- NO RLS POLICY IS CREATED HERE, DELIBERATELY.
--
-- The bucket is public, which lets anyone who knows an object's full path read
-- that object — and the path contains the view token, so the path IS the
-- secret. A select policy on storage.objects would additionally let anyone
-- LIST the bucket, which would hand out the token to anybody who asked. Public
-- read of a known path is the intent; enumeration is not.
-- ============================================================

insert into storage.buckets (id, name, public)
values ('dash', 'dash', true)
on conflict (id) do update set public = true;
