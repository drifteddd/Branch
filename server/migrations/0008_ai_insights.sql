-- what branch's automatic check found when a mod was uploaded: an overview written
-- from the code, the safety score, the mods it needs and the in-game ban risk.
alter table mods add column ai_insights jsonb;
