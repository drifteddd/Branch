-- one shared chat room for everyone, using the same community names as the forum.
-- messages are kept for 30 days.
create table chat_messages (
    id bigserial primary key,
    poster_id uuid not null references forum_posters(id) on delete cascade,
    body text not null,
    removed boolean not null default false,
    removed_at timestamptz,
    created_at timestamptz not null default now()
);
create index chat_messages_created on chat_messages(created_at desc);
create index chat_messages_poster on chat_messages(poster_id, created_at desc);

-- chat messages can be reported too
alter table forum_reports add column chat_id bigint references chat_messages(id) on delete cascade;
