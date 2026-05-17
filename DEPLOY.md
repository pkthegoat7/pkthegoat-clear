# Deploy do painel pkthegoat (multi-usuário)

## ⚠️ Avisos antes de qualquer coisa

1. **Selfbots violam os Termos de Serviço do Discord.** Hospedar como serviço público que aceita tokens de terceiros aumenta muito o risco. Discord pode banir as contas envolvidas; hosts podem suspender o projeto a qualquer momento.
2. **Você fica legalmente responsável** pelas tokens Discord de outras pessoas (dado pessoal sensível: LGPD/GDPR).
3. **Modelo recomendado:** uso restrito (você + pessoas que você criou conta manualmente). **Nunca** abra cadastro público.

## ❌ Vercel NÃO funciona

Vercel é serverless. Selfbot precisa de uma conexão WebSocket persistente com o gateway do Discord. Functions têm timeout de segundos/minutos e não mantêm state entre invocações. **Não tente Vercel.**

## ✅ Render (Web Service) — recomendado

Render oferece "Web Services" persistentes. Funciona. Plano gratuito tem limitações sérias (descritas abaixo).

### Plano Free (não recomendado para produção)
- Servidor adormece após 15 min sem tráfego → Discord desconecta → tarefas perdidas
- **Sem disco persistente** → arquivos em `data/` são apagados a cada deploy. Toda vez que o servidor reinicia, você perde os usuários cadastrados e tokens.

### Plano pago (US$ 7/mês Web Service + US$ 1/mês 1 GB disco)
- Sem sleep, processo sempre ligado
- Disco persistente montado em `/var/data` (ou onde você definir)
- HTTPS automático

### Configuração no Render

1. Criar **Web Service**:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `node index.js`
2. Adicionar **Disk**:
   - Name: `pkthegoat-data`
   - Mount path: `/opt/render/project/src/data` (ou ajuste no código)
   - Size: 1 GB
3. Environment variables:

| Variável | Valor | Descrição |
|---|---|---|
| `PORT` | (auto preenchido pelo Render) | Porta de escuta |
| `PKTHEGOAT_SECURE_COOKIES` | `1` | Cookies só via HTTPS |
| `NODE_VERSION` | `20` | Versão do Node |

O código já detecta `PORT` e faz bind em `0.0.0.0` automaticamente quando ele está definido.

## Antes de subir pro GitHub (checklist)

### 1. Confirme que o `.gitignore` está protegendo segredos

Itens críticos que **NÃO podem ir** para o GitHub:

- `config.json` — contém tokens Discord pessoais do dono em texto claro
- `data/` — banco de usuários + tokens dos usuários cadastrados
- `backups/` — backups de DMs (texto claro)
- `dist/` — executáveis grandes
- `node_modules/`

Todos já estão no `.gitignore`. Antes de cada push:

```bash
git status
```

Se aparecer qualquer um desses arquivos listados, **NÃO faça push** até resolver.

### 2. Crie um repositório DEDICADO para o painel

O `.git` atual em `G:/` aponta para outro projeto (`bot-dc`) e mistura várias pastas alheias. Para subir o painel:

```bash
cd "G:/SELFBOT PKTHEGOAT"
git init
git add .
git status  # CONFIRME: nenhum config.json, data/, backups/, node_modules/
git commit -m "Painel pkthegoat (multi-usuário)"

# Crie um novo repo PRIVADO no GitHub e:
git branch -M main
git remote add origin git@github.com:SEU_USUARIO/painel-pkthegoat.git
git push -u origin main
```

**Crie o repo como PRIVADO no GitHub.** Mesmo sem segredos no código, o projeto inteiro tem implicações de Discord ToS — repo público chama atenção indesejada.

### 3. Se já tiver commitado algum segredo por acidente

Se você fez `git add` e o `config.json` ou `data/` entrou em algum commit:

1. **Considere as tokens dessas contas como vazadas.** Mude-as no Discord (configurações → desconectar todos os dispositivos).
2. Use [git-filter-repo](https://github.com/newren/git-filter-repo) ou recrie o repo do zero. `.gitignore` não remove segredos já commitados.

### 4. Auditoria automática (recomendada)

Antes de tornar o repo público (se um dia fizer isso), rode:

- `gitleaks detect` — scanner de segredos
- `npm audit` — vulnerabilidades em dependências

## Variáveis de ambiente — referência

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `4147` | Porta. Render injeta automaticamente. |
| `PKTHEGOAT_HOST` | `127.0.0.1` (local) / `0.0.0.0` (quando `PORT` está set) | Host de bind |
| `PKTHEGOAT_SECURE_COOKIES` | (vazio) | `1` força `Secure` no cookie. Use sempre em produção HTTPS. |

## Primeiro boot em produção

1. Suba o serviço
2. Acesse o domínio
3. Olhe os logs do Render — vai aparecer:
   ```
   ADMIN INICIAL CRIADO
   Email: patricknicoli55@gmail.com
   Senha: <senha aleatória>
   ```
4. Anote a senha, logue, troque imediatamente (aba "Minha conta")
5. Crie contas para os amigos na aba "Usuários do painel"

## Subir atrás de Caddy ou Nginx (VPS próprio)

### Caddy (mais simples)

```
painel.seudominio.com {
    reverse_proxy 127.0.0.1:4147
}
```

Caddy gera HTTPS sozinho. Depois:

```bash
export PKTHEGOAT_SECURE_COOKIES=1
node index.js
```

Use `pm2` ou `systemd` para manter o processo vivo.

### Nginx + Certbot

```nginx
server {
    listen 443 ssl http2;
    server_name painel.seudominio.com;

    ssl_certificate /etc/letsencrypt/live/painel.seudominio.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/painel.seudominio.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4147;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

## Backup

Os dados sensíveis vivem em `data/`:

- `data/users.json` — emails + hashes scrypt das senhas (sem segredos diretos, mas perder = perder contas)
- `data/user-data/<hash>.json` — **tokens Discord** dos usuários (extremamente sensível)

Backup off-site **criptografado**. Se vazar, contas Discord ficam expostas.

## Limitações conhecidas

- **Sessões em memória**: reiniciar o servidor desloga todo mundo (re-login com email/senha resolve)
- **Sem rate limiting próprio** — ponha na frente (Caddy/Cloudflare) se for público
- **Sem MFA** — se precisar, implemente
- **Discord clients persistentes**: cada usuário conectado mantém uma WS aberta com Discord. ~20 usuários simultâneos = 20 WS. Render gerencia bem; servidores muito pequenos podem sofrer
- **Vercel/Cloudflare Pages/Netlify NÃO funcionam** (todos são serverless)
