-- mods with a github link can pull in new versions from github releases by themselves.
-- github_tag is the newest github release Branch has already seen for the mod.
alter table mods add column github_sync boolean not null default true;
alter table mods add column github_tag text;
alter table mods add column github_checked_at timestamptz;
alter table releases add column from_github boolean not null default false;

-- messages for uploaders about their own mods, shown in their inbox
create table creator_notices (
    id uuid primary key,
    poster_id uuid not null references forum_posters(id) on delete cascade,
    mod_id uuid references mods(id) on delete set null,
    title text not null,
    body text not null default '',
    created_at timestamptz not null default now()
);
create index creator_notices_poster on creator_notices(poster_id, created_at desc);
