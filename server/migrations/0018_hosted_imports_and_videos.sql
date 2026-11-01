-- mods imported from github are hosted on Branch with credit to the author; creators can ask for removal.
update mods set redistribution = 'allowed',
    redistribution_note = 'hosted by Branch with credit to the author. the original is on github. creators can ask for it to be removed at any time at drifted1000@outlook.com.'
where import_info->>'via' = 'github-import' and redistribution <> 'allowed';

-- youtube videos found for mods already on Branch
update mods set video_id = 'AtBcUi8t_3o' where slug = 'twitch-integration' and video_id is null;
update mods set video_id = 'dxlRWr1X-Iw' where slug = 'gorilla-signs' and video_id is null;
update mods set video_id = 'tToXQD-2opk' where slug = 'water-fight' and video_id is null;
update mods set video_id = 'rcB-Je9C0Po' where slug = 'smooth-monke' and video_id is null;
update mods set video_id = '8oNV_M9O0cc' where slug = 'banana-dispenser' and video_id is null;
update mods set video_id = '6tntSgwU2Rw' where slug = 'gsabers' and video_id is null;
update mods set video_id = 'cZZ75PFnJg4' where slug = 'monke-tunes' and video_id is null;
update mods set video_id = '17um16bu6hQ' where slug = 'monke-dimensions' and video_id is null;
update mods set video_id = '3mlNH83thik' where slug = 'gorilla-shirts' and video_id is null;
update mods set video_id = 'JxH16iE7h00' where slug = 'holdable-pad' and video_id is null;
update mods set video_id = 'Q0uV3xN0eZU' where slug = 'seventy-s-camera-settings' and video_id is null;
update mods set video_id = 'Z_OkXAHYf5o' where slug = 'mono-sandbox' and video_id is null;
update mods set video_id = 'ldznEclddDQ' where slug = 'monke-bazooka' and video_id is null;
update mods set video_id = 'mHhclInYi2s' where slug = 'broken-controller' and video_id is null;
update mods set video_id = '7G6EhOONj8o' where slug = 'monke-map-loader' and video_id is null;
update mods set video_id = 'E2tGhLuAdlo' where slug = 'space-monke' and video_id is null;
update mods set video_id = 'gNvoMILgcWc' where slug = 'computer-interface' and video_id is null;
update mods set video_id = 'ynW1c0MM7q8' where slug = 'utilla-library' and video_id is null;
update mods set video_id = 'egIM2o3XqIc' where slug = 'resurgence' and video_id is null;
update mods set video_id = 'WTUqX3c0ih4' where slug = 'unityexplorer-iidk-version' and video_id is null;
update mods set video_id = '1CEEn89s6lc' where slug = 'gorillabody' and video_id is null;
update mods set video_id = 'fUY-V_oaTMQ' where slug = 'atlas' and video_id is null;
update mods set video_id = 'hRJKgXtjEZ0' where slug = 'pepsi-dee-s-mod-checker-real' and video_id is null;
