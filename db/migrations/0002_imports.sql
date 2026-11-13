create table if not exists __SCHEMA__.imports (
  id text primary key,
  created_by text not null references __SCHEMA__.users (id),
  filename text not null,
  file_sha256 text not null,
  file_bytes integer not null,
  row_count integer not null default 0,
  scope_theater_id text references __SCHEMA__.theaters (id),   -- null = all theaters the admin manages
  archive_scope text not null default 'file_window' check (archive_scope in ('file_window', 'full_schedule')),
  status text not null check (status in
    ('uploaded', 'analyzing', 'ready', 'applying', 'applied', 'partially_applied', 'discarded', 'failed')),
  mode text check (mode in ('ai', 'rules_only')),
  model text,
  agent_summary text,
  summary jsonb not null default '{}'::jsonb,      -- counts per action type
  warnings jsonb not null default '[]'::jsonb,
  usage jsonb not null default '{}'::jsonb,        -- turns, tool calls, tokens, milliseconds
  error jsonb,
  plan_hash text,
  created_at timestamptz not null default now(),
  analysis_started_at timestamptz,
  analyzed_at timestamptz,
  applied_at timestamptz,
  applied_by text references __SCHEMA__.users (id)
);
create index if not exists imports_created on __SCHEMA__.imports (created_at desc);

create table if not exists __SCHEMA__.import_files (
  import_id text primary key references __SCHEMA__.imports (id) on delete cascade,
  content text not null                            -- raw CSV, kept for audit and replay
);

create table if not exists __SCHEMA__.import_theaters (
  import_id text not null references __SCHEMA__.imports (id) on delete cascade,
  theater_id text not null references __SCHEMA__.theaters (id),
  base_schedule_version bigint not null,
  window_start timestamptz,
  window_end timestamptz,
  plan_hash text,
  status text not null default 'ready' check (status in ('ready', 'applied', 'conflict', 'failed')),
  counts jsonb not null default '{}'::jsonb,
  error text,
  primary key (import_id, theater_id)
);

create table if not exists __SCHEMA__.import_resolutions (
  id text primary key,
  import_id text not null references __SCHEMA__.imports (id) on delete cascade,
  kind text not null check (kind in ('movie', 'auditorium', 'reschedule')),
  theater_id text references __SCHEMA__.theaters (id),         -- null for movies (global)
  subject_key text not null,
  subject_raw text not null,
  row_numbers integer[] not null default '{}',
  outcome jsonb not null,                          -- {type:'existing',id} | {type:'new',name} | {type:'moved'} | {type:'separate'}
  method text not null check (method in ('alias', 'agent', 'human', 'fallback')),
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  explanation text not null default '',
  candidates jsonb not null default '[]'::jsonb,
  overridden_by text references __SCHEMA__.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists import_resolutions_subject
  on __SCHEMA__.import_resolutions (import_id, kind, coalesce(theater_id, ''), subject_key);

create table if not exists __SCHEMA__.import_actions (
  import_id text not null references __SCHEMA__.imports (id) on delete cascade,
  action_key text not null,                        -- stable across re-derivation (section 10.5)
  theater_id text not null references __SCHEMA__.theaters (id),
  seq integer not null,
  action text not null check (action in ('add', 'restore', 'update', 'reschedule', 'archive', 'unchanged', 'duplicate')),
  target_showtime_id text,
  source_rows integer[] not null default '{}',
  payload jsonb not null default '{}'::jsonb,
  diffs jsonb not null default '[]'::jsonb,        -- [{field, oldValue, newValue}]
  explanation text not null default '',
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  decided_by text not null check (decided_by in ('rule', 'agent', 'human')),
  decision text not null default 'accepted' check (decision in ('pending', 'accepted', 'rejected')),
  result text check (result in ('applied', 'skipped', 'conflict', 'failed')),
  result_detail text,
  primary key (import_id, action_key)
);
create index if not exists import_actions_group on __SCHEMA__.import_actions (import_id, theater_id, action, seq);

create table if not exists __SCHEMA__.import_events (
  id bigint generated always as identity primary key,
  import_id text not null references __SCHEMA__.imports (id) on delete cascade,
  type text not null,                              -- stage | llm_turn | tool_call | resolution | note | warning | error
  message text not null default '',
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists import_events_feed on __SCHEMA__.import_events (import_id, id);

create table if not exists __SCHEMA__.audit_log (
  id bigint generated always as identity primary key,
  actor_user_id text,
  action text not null,
  theater_id text,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists __SCHEMA__.llm_usage_daily (
  day date primary key,
  runs integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0
);
