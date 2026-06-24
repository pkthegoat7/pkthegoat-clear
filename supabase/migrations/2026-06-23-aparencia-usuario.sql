-- Aparência do painel persistida por usuário (sincroniza entre dispositivos).
-- jsonb permite evolução do schema sem novas migrations a cada campo (bg, accent,
-- perf, bgImage, bgImageDim, bgImageBlur, etc.).
alter table public.painel_users
  add column if not exists aparencia jsonb;
