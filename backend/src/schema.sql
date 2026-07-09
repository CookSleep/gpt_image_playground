create table if not exists users (
  id bigserial primary key,
  username text not null unique,
  password_hash text not null,
  nickname text not null,
  role text not null check (role in ('user', 'admin')),
  status text not null check (status in ('pending', 'active', 'disabled')),
  quota_remaining integer not null default 0 check (quota_remaining >= 0),
  quota_used integer not null default 0 check (quota_used >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sessions (
  token_hash text primary key,
  user_id bigint not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists generations (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
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
  revised_prompt text,
  created_at timestamptz not null default now()
);

create table if not exists quota_ledger (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  actor_id bigint references users(id) on delete set null,
  delta integer not null,
  reason text not null,
  balance_after integer not null,
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id bigserial primary key,
  actor_id bigint references users(id) on delete set null,
  action text not null,
  target_user_id bigint references users(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists generations_user_created_idx on generations(user_id, created_at desc);
create index if not exists generation_images_user_idx on generation_images(user_id);
create index if not exists sessions_expires_idx on sessions(expires_at);

