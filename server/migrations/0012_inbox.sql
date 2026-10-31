alter table reports add column poster_id uuid references forum_posters(id) on delete set null;
alter table reports add column reply text not null default '';
create index reports_poster on reports(poster_id, created_at desc);

create table announcements (
    id uuid primary key,
    title text not null,
    body text not null default '',
    kind text not null default 'announcement' check (kind in ('announcement', 'update', 'notice')),
    created_at timestamptz not null default now(),
    created_by uuid references admins(id) on delete set null
);
create index announcements_created on announcements(created_at desc);
