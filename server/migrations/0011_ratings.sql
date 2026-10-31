create table mod_ratings (
    mod_id uuid not null references mods(id) on delete cascade,
    rater text not null,
    stars smallint not null check (stars between 1 and 5),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (mod_id, rater)
);
alter table mods add column rating_sum integer not null default 0;
alter table mods add column rating_count integer not null default 0;
