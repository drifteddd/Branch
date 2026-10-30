-- anyone can upload their own mod. "source" says where a listing came from, and
-- "uploader" is the hashed visitor id, used for the daily upload limit and abuse.
alter table mods add column source text not null default 'admin' check (source in ('admin', 'community'));
alter table mods add column uploader text;
create index mods_uploader on mods(uploader, created_at desc) where uploader is not null;
