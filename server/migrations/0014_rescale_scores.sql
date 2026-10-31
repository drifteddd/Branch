update mods
set ai_insights = jsonb_set(
    jsonb_set(ai_insights, '{risk,score}', to_jsonb(greatest(1, round((ai_insights->'risk'->>'score')::numeric * 0.25))::int)),
    '{risk,label}', '"Looks clean"'
)
where ai_insights ? 'risk'
  and (ai_insights->'risk'->>'score') ~ '^[0-9]+$'
  and (ai_insights->'risk'->>'score')::int <= 40;
