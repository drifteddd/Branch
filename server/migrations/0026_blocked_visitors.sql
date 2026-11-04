-- connections blocked automatically because they looked like a flood. "visitor" is the same
-- keyed hash of the ip address used everywhere else, never the address itself.
create table blocked_visitors (
    visitor text primary key,
    reason text not null default '',
    blocked_at timestamptz not null default now(),
    expires_at timestamptz not null
);
create index blocked_visitors_expires on blocked_visitors(expires_at);
