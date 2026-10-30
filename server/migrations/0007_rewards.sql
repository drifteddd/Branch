-- the robux rewards program.
-- uploads are linked to the uploader's community identity (no accounts), and each upload
-- keeps a fingerprint of its code so new uploads can be checked for copies.

alter table mods add column uploader_poster uuid references forum_posters(id) on delete set null;
alter table mods add column code_fingerprint text[] not null default '{}';
alter table mods add column unique_status text not null default 'unchecked';
create index mods_uploader_poster on mods(uploader_poster) where uploader_poster is not null;

-- switches the admin can flip, like turning the rewards program off
create table app_settings (
    key text primary key,
    value jsonb not null
);
insert into app_settings (key, value) values ('rewards_enabled', 'true');

create table reward_members (
    id uuid primary key,
    poster_id uuid not null unique references forum_posters(id) on delete cascade,
    roblox_username text not null,
    payout_item_url text not null,
    status text not null check (status in ('pending', 'accepted', 'rejected', 'removed')),
    ai_review jsonb,
    admin_note text not null default '',
    applied_at timestamptz not null default now(),
    decided_at timestamptz
);

create table reward_events (
    id bigserial primary key,
    member_id uuid not null references reward_members(id) on delete cascade,
    mod_id uuid references mods(id) on delete set null,
    mod_name text not null,
    amount integer not null,
    day date not null default current_date,
    status text not null default 'owed' check (status in ('owed', 'paid', 'void')),
    created_at timestamptz not null default now(),
    paid_at timestamptz
);
create index reward_events_member on reward_events(member_id, created_at desc);
