create table assistant_usage (
    id bigserial primary key,
    visitor text not null,
    created_at timestamptz not null default now()
);
create index assistant_usage_visitor on assistant_usage(visitor, created_at);
