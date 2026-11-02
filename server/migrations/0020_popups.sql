-- messages or polls the admin shows once in a pop-up when people open the app, until ends_at.
create table popups (
    id uuid primary key,
    kind text not null check (kind in ('message', 'poll')),
    title text not null,
    body text not null default '',
    poll_id uuid references polls(id) on delete cascade,
    ends_at timestamptz not null,
    ended boolean not null default false,
    created_by uuid references admins(id) on delete set null,
    created_at timestamptz not null default now()
);
create index popups_live on popups(ends_at desc) where not ended;
