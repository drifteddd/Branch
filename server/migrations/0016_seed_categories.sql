update mods set category_id = (select id from categories where slug = 'utilities')
where category_id is null and import_info->>'via' = 'github-import'
  and lower(source_url) in ('https://github.com/legoandmars/utilla', 'https://github.com/tonimacaroni/computerinterface', 'https://github.com/hamburbur-org/gorilla-notifications',
                            'https://github.com/larsl2005/gtag-notificationlib', 'https://github.com/gorillatagmoddinghub/gorillalibrary', 'https://github.com/crafterbotofficial/monkenotificationlib');

update mods set category_id = (select id from categories where slug = 'gameplay')
where category_id is null and import_info->>'via' = 'github-import'
  and lower(source_url) in ('https://github.com/vadix88/monkemaploader', 'https://github.com/chin0303/monke-dimensions', 'https://github.com/developer9998/gorillahistoricalteleporter',
                            'https://github.com/graicc/gorillakz', 'https://github.com/lapisgit/gorillatrials');
