-- Reconexão automática do self + sessões persistentes do painel.
-- Objetivo: sobreviver a restart do processo (ex.: Railway reiniciando o
-- container), que antes derrubava login do painel E a conexão do selfbot,
-- já que ambos viviam só em memória.

-- ---------------------------------------------------------------------------
-- A) Token "ativo": qual token de cada usuário está conectado agora. No boot
--    o servidor reconecta esses tokens. O valor do token continua só na coluna
--    cifrada existente (token_cifrado/iv/auth_tag) — aqui é apenas um flag.
-- ---------------------------------------------------------------------------
alter table painel_user_tokens
    add column if not exists ativo boolean not null default false;

create index if not exists idx_painel_user_tokens_ativo
    on painel_user_tokens (ativo) where ativo;

-- ---------------------------------------------------------------------------
-- B) Sessões do painel persistidas. Guarda APENAS o hash SHA-256 do sid; o sid
--    em claro (o que vai no cookie do navegador) nunca é gravado. Assim, um
--    vazamento desta tabela não permite sequestrar sessões.
-- ---------------------------------------------------------------------------
create table if not exists painel_sessoes (
    sid_hash      text primary key,
    email         text not null,
    criada_em     timestamptz not null default now(),
    ultimo_acesso timestamptz not null default now()
);

create index if not exists idx_painel_sessoes_email
    on painel_sessoes (email);

create index if not exists idx_painel_sessoes_ultimo_acesso
    on painel_sessoes (ultimo_acesso);
