-- the whole branch database. later changes go in new numbered files.

create table admins (
    id uuid primary key,
    username text not null unique,
    password_hash text not null,
    must_change_password boolean not null default true,
    failed_logins integer not null default 0,
    locked_until timestamptz,
    created_at timestamptz not null default now(),
    password_changed_at timestamptz
);

create table admin_sessions (
    -- only a sha-256 of the session token is stored, so a database leak can't log anyone in
    token_hash text primary key,
    admin_id uuid not null references admins(id) on delete cascade,
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    expires_at timestamptz not null
);
create index admin_sessions_admin on admin_sessions(admin_id);

create table audit_log (
    id bigserial primary key,
    admin_id uuid references admins(id) on delete set null,
    admin_username text not null,
    action text not null,
    target text not null default '',
    details text not null default '',
    created_at timestamptz not null default now()
);
create index audit_log_created on audit_log(created_at desc);

create table categories (
    id uuid primary key,
    slug text not null unique,
    name text not null,
    description text not null default '',
    sort_order integer not null default 0,
    created_at timestamptz not null default now()
);

create table tags (
    id uuid primary key,
    slug text not null unique,
    name text not null
);

create table mods (
    id uuid primary key,
    slug text not null unique,
    name text not null,
    summary text not null default '',
    description text not null default '',
    author_name text not null default '',
    author_url text,
    category_id uuid references categories(id) on delete set null,
    status text not null default 'draft' check (status in ('draft', 'published', 'unpublished', 'archived')),
    featured boolean not null default false,
    thumbnail_key text,
    compatibility text not null default 'unconfirmed' check (compatibility in ('tested', 'unconfirmed', 'outdated', 'broken')),
    compatibility_note text not null default '',
    compatibility_checked_on date,
    game_versions text not null default '',
    platforms text[] not null default '{}',
    mod_loader text not null default '',
    dependencies jsonb not null default '[]',
    install_instructions text not null default '',
    known_issues text not null default '',
    source_url text,
    project_url text,
    license_name text not null default '',
    license_url text,
    redistribution text not null default 'unknown' check (redistribution in ('allowed', 'not_allowed', 'unknown')),
    redistribution_note text not null default '',
    download_count bigint not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    published_at timestamptz
);
create index mods_status on mods(status);
create index mods_category on mods(category_id);

create table mod_tags (
    mod_id uuid not null references mods(id) on delete cascade,
    tag_id uuid not null references tags(id) on delete cascade,
    primary key (mod_id, tag_id)
);

create table screenshots (
    id uuid primary key,
    mod_id uuid not null references mods(id) on delete cascade,
    image_key text not null,
    caption text not null default '',
    sort_order integer not null default 0,
    created_at timestamptz not null default now()
);
create index screenshots_mod on screenshots(mod_id);

create table releases (
    id uuid primary key,
    mod_id uuid not null references mods(id) on delete cascade,
    version text not null,
    released_on date not null,
    changelog text not null default '',
    game_version text not null default '',
    download_kind text not null check (download_kind in ('hosted', 'external')),
    external_url text,
    file_key text,
    file_name text,
    file_size bigint,
    file_sha256 text,
    file_type text,
    download_disabled boolean not null default false,
    disabled_reason text not null default '',
    created_at timestamptz not null default now()
);
create index releases_mod on releases(mod_id, released_on desc, created_at desc);

-- one row per person per release per day, so download counts can't be spammed.
-- "visitor" is a keyed hash of the ip address, never the address itself.
create table download_events (
    release_id uuid not null references releases(id) on delete cascade,
    visitor text not null,
    day date not null default current_date,
    primary key (release_id, visitor, day)
);

create table reports (
    id uuid primary key,
    mod_id uuid references mods(id) on delete set null,
    mod_name text not null,
    reason text not null check (reason in ('broken_download', 'outdated', 'misleading', 'harmful', 'copyright', 'other')),
    details text not null default '',
    contact text not null default '',
    visitor text not null,
    status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
    admin_note text not null default '',
    created_at timestamptz not null default now(),
    resolved_at timestamptz,
    resolved_by uuid references admins(id) on delete set null
);
create index reports_status on reports(status, created_at desc);
create index reports_visitor on reports(visitor, created_at desc);

-- starter categories. the admin can rename or remove them.
insert into categories (id, slug, name, sort_order) values
    ('00000000-0000-4000-8000-000000000001', 'cosmetics', 'Cosmetics', 1),
    ('00000000-0000-4000-8000-000000000002', 'gameplay', 'Gameplay', 2),
    ('00000000-0000-4000-8000-000000000003', 'utilities', 'Utilities', 3),
    ('00000000-0000-4000-8000-000000000004', 'maps', 'Maps', 4),
    ('00000000-0000-4000-8000-000000000005', 'libraries', 'Libraries', 5);
