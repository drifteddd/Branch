-- optional creator accounts. an account is a username and password attached to a community
-- identity, so a creator can use the creator hub, edit their uploads and earn rewards from
-- any computer. passwords are stored as argon2 hashes. accounts are never required to upload.

create table creator_accounts (
    poster_id uuid primary key references forum_posters(id) on delete cascade,
    username text not null,
    username_lower text not null unique,
    password_hash text not null,
    created_at timestamptz not null default now(),
    last_login_at timestamptz
);

-- a computer that logged in to an account. key_hash is the sha-256 of that computer's
-- community key, so its requests act as the account until it logs out.
create table creator_logins (
    key_hash text primary key,
    poster_id uuid not null references forum_posters(id) on delete cascade,
    created_at timestamptz not null default now()
);
create index creator_logins_poster on creator_logins(poster_id);
