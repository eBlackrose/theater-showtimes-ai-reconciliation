-- When an apply was claimed, so an apply whose function died can be claimed again.
alter table __SCHEMA__.imports add column if not exists apply_started_at timestamptz;
