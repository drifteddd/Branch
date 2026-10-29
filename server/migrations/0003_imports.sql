-- mods brought in with the bulk importer stay as drafts until they're filled in and published.
alter table mods add column imported_at timestamptz;
-- the file name and the basic scan result from when it was imported
alter table mods add column import_info jsonb;
create index mods_imported on mods(imported_at) where imported_at is not null;
