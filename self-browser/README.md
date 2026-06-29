# self-browser

Serviço separado que abre o **Discord web logado como o self** num Chromium
headless (Playwright) e **transmite a tela** para o painel via WebSocket
(screencast CDP, jpeg), recebendo mouse/teclado de volta.

Roda **fora do painel** de propósito: isola RAM/CPU/custo e não afeta o deploy
do painel. Deploy por Docker (Railway como 2º serviço, ou qualquer VPS).

## ⚠️ Risco
Logar o token do self num browser automatizado é **mais detectável** que o
selfbot por gateway. O Discord pode **marcar/banir** a conta e pode quebrar o
truque de injeção de token a qualquer momento. Use ciente disso.

## Como funciona
1. O painel valida a sessão do usuário e emite um **ticket HMAC** curto
   (`{email, nome, exp}`, expira em ~30s), assinado com `BROWSER_SHARED_SECRET`.
2. O navegador do usuário conecta em `wss://<este-serviço>/stream?ticket=...`.
3. Este serviço valida o ticket, **lê o token cifrado do Supabase** e decifra
   (mesmo `ENCRYPTION_KEY` do painel), lança o Chromium e injeta o token.
4. Frames jpeg vão para o cliente; mouse/teclado voltam via CDP.

O token **nunca** passa pelo navegador do usuário — só pixels.

## Variáveis de ambiente
Ver `.env.example`. Precisa de:
- `BROWSER_SHARED_SECRET` — igual ao do painel (`openssl rand -base64 32`).
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY` — **os mesmos do
  painel** (para ler/decifrar o token).
- `PORT` — Railway injeta; local usa 8090.

No **painel**, defina: `SELF_BROWSER_URL` (ex.: `https://self-browser.up.railway.app`)
e o mesmo `BROWSER_SHARED_SECRET`.

## Deploy

### Railway (2º serviço no mesmo projeto)
1. New Service → Deploy from repo → **Root Directory: `self-browser`**.
2. Builder: Dockerfile (já há `railway.json`). Recomenda-se ≥1GB RAM.
3. Configure as envs acima. Copie a URL pública para `SELF_BROWSER_URL` no painel.

### Docker (VPS)
```bash
docker build -t self-browser ./self-browser
docker run -p 8090:8090 --env-file ./self-browser/.env self-browser
```

## Requisitos
- RAM: ~1GB (2GB confortável). Chromium é lançado **sob demanda** e fecha após
  ~5 min de ociosidade ou ao desconectar.
- A versão do `playwright` (package.json) deve casar com a tag da imagem no
  `Dockerfile`.
