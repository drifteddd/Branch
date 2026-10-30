-- the community forum. there are no accounts: each app makes a random secret key and keeps
-- it on the person's computer. the server only stores a sha-256 of that key, plus a
-- random (changeable) username and a hashed visitor id for spam limits and bans.

create table forum_posters (
    id uuid primary key,
    key_hash text not null unique,
    name text not null,
    visitor text not null,
    banned boolean not null default false,
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
);
create index forum_posters_visitor on forum_posters(visitor);

create table forum_threads (
    id uuid primary key,
    board text not null check (board in ('general', 'help', 'showcase', 'ideas')),
    poster_id uuid not null references forum_posters(id) on delete cascade,
    title text not null,
    body text not null,
    pinned boolean not null default false,
    locked boolean not null default false,
    removed boolean not null default false,
    reply_count integer not null default 0,
    created_at timestamptz not null default now(),
    last_post_at timestamptz not null default now()
);
create index forum_threads_list on forum_threads(board, pinned desc, last_post_at desc);
create index forum_threads_poster on forum_threads(poster_id, created_at desc);

create table forum_replies (
    id uuid primary key,
    thread_id uuid not null references forum_threads(id) on delete cascade,
    poster_id uuid not null references forum_posters(id) on delete cascade,
    body text not null,
    removed boolean not null default false,
    created_at timestamptz not null default now()
);
create index forum_replies_thread on forum_replies(thread_id, created_at);
create index forum_replies_poster on forum_replies(poster_id, created_at desc);

create table forum_reports (
    id uuid primary key,
    thread_id uuid references forum_threads(id) on delete cascade,
    reply_id uuid references forum_replies(id) on delete cascade,
    reason text not null,
    visitor text not null,
    status text not null default 'open' check (status in ('open', 'closed')),
    created_at timestamptz not null default now(),
    closed_at timestamptz
);
create index forum_reports_status on forum_reports(status, created_at desc);
