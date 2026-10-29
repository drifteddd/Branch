-- mod requests from people using the app, and the ai mod checker.

create table mod_requests (
    id uuid primary key,
    mod_name text not null,
    url text not null,
    author text not null default '',
    details text not null default '',
    contact text not null default '',
    visitor text not null,
    status text not null default 'open' check (status in ('open', 'accepted', 'denied')),
    admin_note text not null default '',
    created_mod_id uuid references mods(id) on delete set null,
    created_at timestamptz not null default now(),
    decided_at timestamptz,
    decided_by uuid references admins(id) on delete set null
);
create index mod_requests_status on mod_requests(status, created_at desc);
create index mod_requests_visitor on mod_requests(visitor, created_at desc);

-- how many checks each visitor used per day. "__ai_calls__" counts paid ai calls for everyone,
-- so there's a hard daily ceiling on what the checker can spend.
create table ai_usage (
    visitor text not null,
    day date not null default current_date,
    count integer not null default 0,
    primary key (visitor, day)
);

-- results are cached by the file's sha-256, so the same file never costs a second ai call.
-- the file itself is never stored.
create table ai_results (
    sha256 text primary key,
    result jsonb not null,
    created_at timestamptz not null default now()
);
