# Deploy do painel pkthegoat

## ⚠️ Avisos

1. **Selfbots violam os Termos do Discord.** Hospedar como serviço público que aceita tokens de terceiros aumenta o risco. Discord pode banir contas; hosts podem suspender o projeto.
2. **Você fica responsável** pelos tokens Discord dos usuários (dado pessoal sensível).
3. **Modelo recomendado:** restrito (você + pessoas que você criou conta manualmente). Nunca abra cadastro público.
4. **Vercel/Netlify/Cloudflare Pages NÃO funcionam** — são serverless, selfbot precisa de WebSocket persistente com o gateway Discord.

---

## Stack escolhida: Railway + Supabase

- **Railway** roda o processo Node 24/7. Free trial dá US$ 5 de crédito; depois ~US$ 5/mês.
- **Supabase** guarda usuários do painel + tokens Discord (criptografados). Free tier serve.

### Por que Supabase + criptografia local?

Tokens Discord no banco vão **cifrados com AES-256-GCM** usando uma chave (`ENCRYPTION_KEY`) que vive só no Railway. Se o banco vazar mas a chave não, as tokens ficam ilegíveis. RLS do Supabase também está ligado, mas o backend usa `service_role` (que bypassa RLS) — a isolação por usuário é garantida pelo código do app filtrando todas as queries por email da sessão.

---

## Setup passo a passo

### 1. Configurar Supabase

Projeto **`pkthegoat-clear`** já criado (id `numoyojqvlvdtwnnrgcx`, região `us-west-1`).

Schema já aplicado (migração `painel_pkthegoat_schema_inicial`):
- `painel_users` — auth do painel (email + scrypt hash)
- `painel_user_tokens` — tokens Discord cifrados (AES-GCM)

Pega as credenciais:
1. https://supabase.com/dashboard/project/numoyojqvlvdtwnnrgcx/settings/api
2. Copie:
   - **Project URL** → vai em `SUPABASE_URL`
   - **service_role** (NÃO a anon) → vai em `SUPABASE_SERVICE_ROLE_KEY`

### 2. Gerar chave de criptografia

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Anote a saída — vai em `ENCRYPTION_KEY`.

⚠️ **Não troque essa chave depois.** Se trocar, as tokens já salvas viram lixo.

### 3. Deploy no Railway

1. https://railway.app/new → conecte o GitHub → escolha `pkthegoat7/pkthegoat-clear`
2. Service detecta Node automaticamente. Defina:
   - **Start Command:** `node index.js` (geralmente automático via `package.json`)
   - **Healthcheck Path:** `/health`
3. **Variables** (no Service):

| Variável | Valor |
|---|---|
| `SUPABASE_URL` | `https://numoyojqvlvdtwnnrgcx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | (do dashboard Supabase) |
| `ENCRYPTION_KEY` | (a que você gerou) |
| `PKTHEGOAT_SECURE_COOKIES` | `1` |
| `NODE_VERSION` | `20` |

`PORT` o Railway injeta sozinho. O código detecta e faz bind em `0.0.0.0`.

4. Deploy. Olhe os logs:
   - Procure por `ADMIN INICIAL CRIADO` — vai aparecer email + senha aleatória
   - Anote a senha
5. Abra o domínio que o Railway gerou
6. Logue, troque a senha (aba **Minha conta**)
7. Crie usuários para os amigos (aba **Usuários do painel**)

### 4. Pós-deploy

- Delete logs antigos do Railway que tenham a senha inicial
- Verifique `/health` respondendo: `https://seu-dominio.up.railway.app/health` → `ok`
- Confirme HTTPS está ativo (Railway dá HTTPS automático)

---

## Rodando localmente

```bash
# Instale deps
npm install

# Copie e preencha o .env
cp .env.example .env
# edite .env com seus valores

# Rode
node index.js
```

Sem `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` definidos, o app cai num modo de dev que usa arquivos JSON em `data/` (não recomendado pra produção).

---

## Backups

O Supabase faz backups diários automáticos no plano free (retenção limitada — 1 dia). Se quiser garantia maior:

- Plano Pro do Supabase = US$ 25/mês, retenção 7 dias
- Ou exporte manualmente: `pg_dump` apontando para `db.numoyojqvlvdtwnnrgcx.supabase.co`

Atenção: backups do banco contêm `token_cifrado`. Sem a `ENCRYPTION_KEY` não dá pra usar. Guarde a chave separada num cofre (Bitwarden, 1Password, etc.).

---

## Trocar/recuperar a ENCRYPTION_KEY

**Não dá pra trocar** sem perder acesso às tokens já cifradas. Se precisar:

1. Cada usuário precisa re-adicionar as tokens Discord
2. Ou você zera a tabela:
   ```sql
   delete from painel_user_tokens;
   ```
3. Depois pode gerar nova `ENCRYPTION_KEY` e redeployar

---

## Rotação do service_role do Supabase

Se vazar:

1. Supabase → Settings → API → "Generate new service_role key"
2. Atualize `SUPABASE_SERVICE_ROLE_KEY` no Railway → triggers redeploy

---

## Custos resumidos

| Serviço | Plano | Custo |
|---|---|---|
| Railway | Trial → Hobby | US$ 0–5/mês após trial |
| Supabase | Free | US$ 0 (500 MB DB, suficiente) |
| GitHub repo | Public | US$ 0 |
| **Total** | | **~US$ 5/mês depois do trial** |

---

## Limitações conhecidas

- Sessões em memória: reiniciar o processo desloga todo mundo (re-login email/senha resolve)
- Sem rate limiting próprio — Railway oferece via plugin se necessário
- Sem MFA por enquanto
- ~20 usuários simultâneos = 20 conexões WebSocket Discord — Railway aguenta bem
- Selfbot detection: Discord pode banir contas em massa se identificar padrão de selfbot

---

## Variáveis de ambiente — referência completa

| Variável | Obrigatória? | Descrição |
|---|---|---|
| `SUPABASE_URL` | em produção | URL do projeto Supabase. Sem isso, cai em modo JSON local. |
| `SUPABASE_SERVICE_ROLE_KEY` | em produção | service_role (bypassa RLS). NUNCA exponha. |
| `ENCRYPTION_KEY` | em produção | chave AES-256 (base64). Gere com `crypto.randomBytes(32)`. |
| `PORT` | (auto) | Injetada pelo Railway/Render. Local default: 4147. |
| `PKTHEGOAT_HOST` | não | Default: `127.0.0.1` local / `0.0.0.0` quando `PORT` está set. |
| `PKTHEGOAT_SECURE_COOKIES` | em produção HTTPS | `1` força `Secure` no cookie. |
