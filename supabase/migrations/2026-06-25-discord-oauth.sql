-- Login via Discord (OAuth2) para o painel pkthegoat.
-- Colunas nullable: contas antigas (email/senha) continuam funcionando sem mudança.
alter table public.painel_users
  add column if not exists discord_id text,
  add column if not exists discord_username text;

-- Um mesmo Discord só pode estar ligado a uma única conta do painel.
create unique index if not exists painel_users_discord_id_key
  on public.painel_users (discord_id)
  where discord_id is not null;
