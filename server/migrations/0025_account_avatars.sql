-- the profile picture a creator picked (a colour and an icon), so it follows their account.
alter table creator_accounts add column avatar jsonb;
