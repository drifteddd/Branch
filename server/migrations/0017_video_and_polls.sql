-- an optional youtube video shown on the mod page, stored as the 11 character video id
alter table mods add column video_id text;

-- polls the admin posts in the community tab. votes are one per person (hashed visitor id), and can be changed while the poll is open.
create table polls (
    id uuid primary key,
    question text not null,
    closed boolean not null default false,
    closes_at timestamptz,
    created_by uuid references admins(id) on delete set null,
    created_at timestamptz not null default now()
);
create table poll_options (
    id uuid primary key,
    poll_id uuid not null references polls(id) on delete cascade,
    label text not null,
    sort_order integer not null default 0
);
create index poll_options_poll on poll_options(poll_id, sort_order);
create table poll_votes (
    poll_id uuid not null references polls(id) on delete cascade,
    voter text not null,
    option_id uuid not null references poll_options(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (poll_id, voter)
);
