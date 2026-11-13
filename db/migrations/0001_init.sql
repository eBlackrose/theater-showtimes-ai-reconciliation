-- Schema-scoped and idempotent. __SCHEMA__ is replaced by the migration runner.
create schema if not exists __SCHEMA__;
create extension if not exists pg_trgm;

create table if not exists __SCHEMA__.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists __SCHEMA__.theaters (
  id text primary key,
  name text not null,
  normalized_name text not null unique,
  location text not null default '',
  timezone text not null default 'UTC',
  schedule_version bigint not null default 0,      -- bumped on every schedule write
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists __SCHEMA__.users (
  id text primary key,
  name text not null,
  email text not null unique,
  role text not null check (role in ('admin', 'viewer')),
  created_at timestamptz not null default now()
);

create table if not exists __SCHEMA__.user_theaters (
  user_id text not null references __SCHEMA__.users (id) on delete cascade,
  theater_id text not null references __SCHEMA__.theaters (id) on delete cascade,
  primary key (user_id, theater_id)
);
create index if not exists user_theaters_theater on __SCHEMA__.user_theaters (theater_id);

create table if not exists __SCHEMA__.movies (
  id text primary key,
  title text not null,                             -- canonical display title
  normalized_title text not null unique,           -- matching and search key
  created_by_import_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists movies_title_trgm on __SCHEMA__.movies using gin (normalized_title gin_trgm_ops);

create table if not exists __SCHEMA__.movie_aliases (
  id bigint generated always as identity primary key,
  movie_id text not null references __SCHEMA__.movies (id) on delete cascade,
  alias text not null,                             -- spelling as seen
  normalized_alias text not null unique,           -- one alias maps to exactly one movie
  source text not null check (source in ('seed', 'rule', 'agent', 'human')),
  import_id text,
  created_at timestamptz not null default now()
);
create index if not exists movie_aliases_trgm on __SCHEMA__.movie_aliases using gin (normalized_alias gin_trgm_ops);
create index if not exists movie_aliases_movie on __SCHEMA__.movie_aliases (movie_id);

create table if not exists __SCHEMA__.auditoriums (
  id text primary key,
  theater_id text not null references __SCHEMA__.theaters (id) on delete cascade,
  name text not null,
  normalized_name text not null,
  created_by_import_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (theater_id, normalized_name),
  unique (id, theater_id)                          -- target of the composite foreign keys below
);

create table if not exists __SCHEMA__.auditorium_aliases (
  id bigint generated always as identity primary key,
  auditorium_id text not null,
  theater_id text not null,
  alias text not null,
  normalized_alias text not null,
  source text not null check (source in ('seed', 'rule', 'agent', 'human')),
  import_id text,
  created_at timestamptz not null default now(),
  unique (theater_id, normalized_alias),
  foreign key (auditorium_id, theater_id) references __SCHEMA__.auditoriums (id, theater_id) on delete cascade
);

create table if not exists __SCHEMA__.showtimes (
  id text primary key,
  theater_id text not null references __SCHEMA__.theaters (id) on delete cascade,
  movie_id text not null references __SCHEMA__.movies (id),
  auditorium_id text not null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  language text not null default '',
  format text not null default '',
  rating text not null default '',
  movie_status text not null default 'needs-review'
    check (movie_status in ('approved', 'draft', 'flagged', 'needs-review')),
  status text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  last_updated timestamptz not null,               -- partner-supplied
  source_title text,                               -- raw strings from the last import that touched the row
  source_auditorium text,
  last_import_id text,
  row_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint showtimes_time_order check (end_time > start_time),
  constraint showtimes_identity unique (theater_id, movie_id, start_time),
  constraint showtimes_auditorium_same_theater
    foreign key (auditorium_id, theater_id) references __SCHEMA__.auditoriums (id, theater_id)
);
create index if not exists showtimes_theater_status_start on __SCHEMA__.showtimes (theater_id, status, start_time);
create index if not exists showtimes_theater_start on __SCHEMA__.showtimes (theater_id, start_time);
create index if not exists showtimes_movie on __SCHEMA__.showtimes (movie_id);
