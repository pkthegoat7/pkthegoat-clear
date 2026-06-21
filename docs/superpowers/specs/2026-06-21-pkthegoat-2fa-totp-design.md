# Design: 2FA (TOTP) no painel pkthegoat

**Data:** 2026-06-21
**Status:** Aprovado (aguardando revisão do spec)
**Escopo:** Adicionar autenticação de dois fatores (TOTP) ao painel web do pkthegoat-clear.

## Contexto

O painel (`src/services/web-ui-server.js`) autentica via `POST /api/auth/site/login`
(`autenticar()` em `src/services/auth.js`, scrypt contra a tabela Supabase `painel_users`)
e cria uma sessão (`criarSessao()`, cookie `pkthegoat_sid` = `randomBytes(32)`, sessões
num `Map` em memória). O super-admin (`patricknicoli55@gmail.com`) vê todos os tokens
Discord cifrados — é a conta de maior risco. Já existem rate-limit de login, `audit.log`
de tentativas e reconfirmação de senha em operações sensíveis.

`src/ui/web-ui.html` é um SPA single-file **minificado** (217KB numa linha). Por isso o
2FA NÃO deve editar esse blob; segue o padrão já adotado (ex.: `auditoria.html`) de
páginas standalone limpas.

## Decisões

- **Método:** TOTP (app autenticador). Sem dependência externa nova — RFC 6238 com `crypto` nativo.
- **Escopo:** opcional para todos os usuários; **obrigatório para o super-admin**.
- **Recuperação:** códigos de backup de uso único **+** escape hatch via servidor (script na VPS).
- **UI:** página `/login` standalone (não-minificada). Zero edição no SPA minificado.

## Arquitetura

### 1. Modelo de dados — migration na tabela Supabase `painel_users`

Novas colunas, todas nullable / com default (usuários existentes ficam sem 2FA, sem quebra):

| Coluna | Tipo | Significado |
|---|---|---|
| `totp_secret_cifrado` | text | Segredo TOTP cifrado com AES-256-GCM (`crypto.js`, `ENCRYPTION_KEY`). Null = sem 2FA. |
| `totp_ativado` | boolean default false | Só `true` após confirmação do enrollment. |
| `totp_backup_codes` | jsonb | Array de **hashes scrypt** dos códigos de backup (nunca em claro). Uso único: hash removido ao consumir. |
| `totp_ativado_em` | timestamptz | Auditoria. |

A migration é entregue como SQL versionado e aplicada via Supabase MCP (`apply_migration`).

### 2. Novo módulo `src/services/totp.js`

RFC 6238 puro usando `crypto` nativo (sem dep nova):
- `gerarSegredo()` → bytes aleatórios + base32 (para o URI `otpauth://`).
- `base32Encode()` / `base32Decode()`.
- `gerarCodigo(secret, t)` → HMAC-SHA1, passo 30s, 6 dígitos.
- `verificar(secret, codigo)` → compara com janela ±1 passo (tolerância de clock skew), comparação em tempo constante.
- `montarUri(email, secret)` → `otpauth://totp/pkthegoat:<email>?secret=<base32>&issuer=pkthegoat`.

QR Code é renderizado **no cliente** (lib QR mínima embutida nas páginas limpas), a partir
do URI devolvido pela API. A API nunca precisa gerar imagem.

### 3. Fluxo de login em duas fases (API)

`POST /api/auth/site/login` (após senha válida):
- **Sem 2FA ativo:** cria sessão como hoje (retrocompatível, sem mudança de comportamento).
- **Com 2FA ativo:** NÃO cria sessão. Cria um *desafio* efêmero e retorna
  `{ sucesso: true, etapa: '2fa', desafio: <id> }`. Sem cookie ainda.

Desafio 2FA (Map em memória, análogo a `sessoes`):
- chave aleatória (`randomBytes`), valor `{ email, criadoEm, tentativas }`.
- TTL 5 min, uso único (removido ao autenticar), cap de 5 tentativas → invalida.

`POST /api/auth/site/2fa` (rota pública, adicionada a `ROTAS_PUBLICAS`):
- Body `{ desafio, codigo }`.
- Valida desafio (existe, não expirou, sob o cap). Incrementa `tentativas`.
- Verifica `codigo` como TOTP **ou** como código de backup (consome o hash se backup).
- Sucesso → `criarSessao()` + `setSessionCookie()`, remove desafio, devolve `{ sucesso, usuario }`.
- Falha → 401; ao estourar o cap ou expirar → 401 com instrução de refazer o login.
- Rate-limit por IP reusando `loginBloqueado`/`registrarTentativaLogin`.

### 4. Super-admin obrigatório (espelha o gate `senhaPrecisaTroca`)

`buscarUsuario()` passa a expor `precisa2fa` = (`emailNormalizado(email) === ADMIN_EMAIL_DEFAULT` && `!totp_ativado`).

- Quando o super-admin loga sem 2FA, a sessão é criada normalmente porém com `precisa2fa=true`.
- Novo conjunto `ROTAS_PERMITIDAS_SEM_2FA` (somente `/api/auth/site/me`, `/logout`, e os
  endpoints de setup/ativar 2FA) — qualquer outra rota retorna bloqueio até o 2FA ficar ativo,
  espelhando o gate existente de `senhaPrecisaTroca`.
- A rota que serve o SPA em `/` redireciona para `/login` quando **não há sessão** OU quando
  `sessao.precisa2fa` é `true`. Assim o enrollment forçado ocorre na página limpa, **sem tocar
  no SPA minificado**.

### 5. Endpoints de gestão (autenticado)

- `POST /api/auth/site/2fa/setup` → gera segredo se não houver/ainda não confirmado,
  grava cifrado com `totp_ativado=false`, devolve `{ uri, secret }` (secret p/ digitação manual).
- `POST /api/auth/site/2fa/ativar` → `{ codigo }`; verifica contra o segredo pendente; em
  sucesso seta `totp_ativado=true` + `totp_ativado_em`, gera N códigos de backup, grava os
  hashes e **devolve os códigos em claro uma única vez**.
- `POST /api/auth/site/2fa/desativar` → `{ senha }` (reconfirma via `reconfirmarSenha`);
  limpa segredo/ativado/backup. **Bloqueado para o super-admin** (2FA é obrigatório → 403).
- `POST /api/auth/site/2fa/backup/regenerar` → `{ senha }`; gera novos códigos (invalida os antigos).
- `GET /api/auth/site/me` passa a incluir `{ totpAtivado, backupRestantes }`.

Parâmetros: **10 códigos de backup** (8 chars base32 cada), **TTL do desafio 5 min**, cap 5 tentativas.

### 6. Páginas limpas (padrão `auditoria.html`)

- `src/ui/login.html` servida em `GET /login`:
  fase 1 e-mail+senha → se `etapa:'2fa'` mostra input de 6 dígitos + link "usar código de
  backup" → `POST /2fa` → redireciona `/`. Se `/me` indicar `precisa2fa`, mostra o enrollment
  forçado (QR + segredo + confirmar código → exibe os backup codes uma vez → `/`).
- `src/ui/conta-2fa.html` servida em `GET /conta/2fa`:
  gestão voluntária para os demais usuários (ligar / desligar / regenerar), acessível por URL.
  Reusa os mesmos endpoints de setup/ativar.

Tabelas/inputs montados com `textContent` (consistente com `auditoria.html`, evita XSS).

Follow-up opcional (decisão do dono, fora do escopo deste spec): adicionar um link "2FA"
no menu do SPA — seria a única edição no `web-ui.html` minificado e por isso fica de fora.

### 7. Escape hatch (anti-lockout)

`scripts/2fa-reset.js <email>` rodado na VPS: usando `service_role`, limpa
`totp_secret_cifrado`, `totp_ativado`, `totp_backup_codes` e zera `totp_ativado_em` da conta.
Garante que o dono nunca fica trancado mesmo perdendo o app e os códigos de backup.
Registra evento `2fa.reset` no `audit.log`.

### 8. Segurança & auditoria

- Códigos de backup: scrypt (mesmo esquema das senhas), uso único, exibidos só no enrollment.
- Rate-limit no `/2fa` (cap por desafio + limite por IP) contra brute-force dos 6 dígitos.
- Segredo TOTP decifrado só em memória, no instante da verificação.
- Comparação de código TOTP em tempo constante (`timingSafeEqual`).
- Eventos no `audit.log` via `registrarAuditoria`: `2fa.setup`, `2fa.ativado`,
  `2fa.desativado`, `2fa.login.sucesso`, `2fa.login.falha`, `2fa.backup.usado`, `2fa.reset`.

### 9. Testes

- Unit `totp.js`: vetores oficiais RFC 6238, janela ±1, base32 roundtrip, rejeição de código errado.
- Login 2 fases: sem 2FA passa direto; com 2FA exige código; código de backup autentica e é consumido (segunda tentativa com o mesmo falha).
- Gate do super-admin: sem 2FA fica preso em `ROTAS_PERMITIDAS_SEM_2FA` até ativar.
- Desafio: expira após TTL; invalida ao estourar o cap de tentativas.
- `desativar` exige senha correta e é negado para o super-admin.

## Compatibilidade / rollout

1. Aplicar a migration (colunas nullable → nenhum usuário existente é afetado).
2. Deploy: usuários comuns continuam logando normalmente (sem 2FA).
3. No próximo login do super-admin, ele é forçado a configurar 2FA antes de usar o painel.
4. Demais usuários podem aderir voluntariamente em `/conta/2fa`.

## Fora de escopo

- 2FA por e-mail/SMS, passkeys/WebAuthn.
- Link de 2FA dentro do SPA minificado (follow-up opcional).
- Rotação/troca do esquema de sessão (continua o `Map` em memória atual).
