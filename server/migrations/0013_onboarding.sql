create table onboarding_stats (
    kind text not null,
    value text not null,
    count bigint not null default 0,
    primary key (kind, value)
);
