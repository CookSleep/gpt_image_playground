create table if not exists users (
  id bigserial primary key,
  username text not null unique,
  email text,
  external_provider text not null,
  external_user_id text not null,
  nickname text not null,
  role text not null check (role in ('user', 'admin')),
  status text not null check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_settings (
  user_id bigint primary key references users(id) on delete cascade,
  image_api_key_id text,
  prompt_api_key_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists asset_folders (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sessions (
  token_hash text primary key,
  user_id bigint not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  sub2api_access_token text,
  sub2api_refresh_token text,
  sub2api_token_expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists generations (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  api_key_id text,
  api_key_name text,
  prompt text not null,
  params jsonb not null default '{}'::jsonb,
  status text not null check (status in ('running', 'done', 'error')),
  model text not null,
  error text,
  upstream jsonb,
  elapsed_ms integer,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists generation_images (
  id bigserial primary key,
  generation_id bigint not null references generations(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  object_key text not null,
  content_type text not null,
  name text not null,
  folder_id bigint references asset_folders(id) on delete set null,
  revised_prompt text,
  created_at timestamptz not null default now()
);

create index if not exists generations_user_created_idx on generations(user_id, created_at desc);
create index if not exists generation_images_user_idx on generation_images(user_id);
create unique index if not exists asset_folders_user_name_idx on asset_folders(user_id, lower(name));
create index if not exists sessions_expires_idx on sessions(expires_at);

drop table if exists quota_ledger;
drop table if exists audit_logs;
alter table users drop column if exists password_hash;
alter table users drop column if exists quota_remaining;
alter table users drop column if exists quota_used;
alter table users add column if not exists email text;
alter table users add column if not exists external_provider text not null default 'sub2api';
alter table users add column if not exists external_user_id text not null default '';
alter table sessions add column if not exists sub2api_access_token text;
alter table sessions add column if not exists sub2api_refresh_token text;
alter table sessions add column if not exists sub2api_token_expires_at timestamptz;
alter table generations add column if not exists api_key_id text;
alter table generations add column if not exists api_key_name text;
alter table generation_images add column if not exists name text;
alter table generation_images add column if not exists folder_id bigint references asset_folders(id) on delete set null;
create index if not exists generation_images_folder_idx on generation_images(user_id, folder_id, created_at desc);

update generation_images set name = 'Aurora 图片 ' || to_char(created_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') where name is null;
alter table generation_images alter column name set not null;

delete from users where external_user_id = '';
drop index if exists users_external_identity_idx;
create unique index users_external_identity_idx on users(external_provider, external_user_id);
