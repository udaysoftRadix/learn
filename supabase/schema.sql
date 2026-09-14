-- Kimi chat persistence schema.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.

create table if not exists chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references chats(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  model text,
  sources jsonb,
  attachment_name text,
  attachment_used boolean,
  created_at timestamptz not null default now()
);

create index if not exists messages_chat_id_idx on messages(chat_id);
create index if not exists chats_user_id_updated_at_idx on chats(user_id, updated_at desc);

-- Bump the parent chat's updated_at whenever a message is added, so the
-- chat list can sort by "most recently active" without extra app-side calls.
create or replace function touch_chat_updated_at()
returns trigger as $$
begin
  update chats set updated_at = now() where id = new.chat_id;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists messages_touch_chat on messages;
create trigger messages_touch_chat
  after insert on messages
  for each row execute function touch_chat_updated_at();

-- Row Level Security: every user can only ever see/change their own chats,
-- and messages that belong to one of their own chats.
alter table chats enable row level security;
alter table messages enable row level security;

drop policy if exists "chats: owner full access" on chats;
create policy "chats: owner full access" on chats
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "messages: owner full access" on messages;
create policy "messages: owner full access" on messages
  for all
  using (exists (select 1 from chats where chats.id = messages.chat_id and chats.user_id = auth.uid()))
  with check (exists (select 1 from chats where chats.id = messages.chat_id and chats.user_id = auth.uid()));
