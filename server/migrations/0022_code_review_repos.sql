-- a review can also be matched by the mod's github repo, for files that change after the review.
alter table code_reviews drop constraint code_reviews_pkey;
alter table code_reviews alter column sha256 drop not null;
alter table code_reviews add column id bigserial primary key;
alter table code_reviews add column repo text;
create unique index code_reviews_sha on code_reviews(sha256) where sha256 is not null;
create index code_reviews_repo on code_reviews(lower(repo));
