-- 2FA (TOTP) para o painel pkthegoat.
-- Colunas nullable / com default: usuários existentes ficam sem 2FA (sem quebra).
alter table public.painel_users
  add column if not exists totp_secret_cifrado text,
  add column if not exists totp_ativado boolean not null default false,
  add column if not exists totp_backup_codes jsonb,
  add column if not exists totp_ativado_em timestamptz,
  add column if not exists totp_last_step bigint;
