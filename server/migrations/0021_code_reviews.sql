-- results of reviewing a mod's source code for anything harmful, keyed by the sha-256 of the
-- file that was on Branch when its source was reviewed, so a new version needs a new review.
create table code_reviews (
    sha256 text primary key,
    verdict text not null check (verdict in ('clean', 'caution', 'flagged')),
    notes text not null default '',
    source_url text,
    reviewed_at timestamptz not null default now()
);
