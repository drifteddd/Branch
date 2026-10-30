-- the player tracker: the newest room cards read from the tracker channel. only the
-- room, region and each player's name, id and color are kept, and only the last 50.
create table tracker_cards (
    message_id text primary key,
    room text not null,
    region text not null default '',
    player_count integer not null default 0,
    players jsonb not null default '[]',
    posted_at timestamptz not null,
    created_at timestamptz not null default now()
);
create index tracker_cards_posted on tracker_cards(posted_at desc);
