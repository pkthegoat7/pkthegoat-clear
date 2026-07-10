# Estrutura do projeto — pkthegoat-clear

> Documento de onboarding técnico para entender a base antes de implementar novas funções.

## Resumo

`pkthegoat-clear` é uma aplicação Node.js CommonJS que roda um painel HTTP próprio, sem Express, para autenticar usuários do painel, armazenar tokens Discord criptografados e executar ações de selfbot por usuário.

Stack observada:

- **Runtime:** Node.js `>=22` (`index.js` como entrypoint).
- **Servidor web:** `http` nativo em `src/services/web-ui-server.js`.
- **Persistência produção:** Supabase com `service_role` no backend.
- **Persistência dev/local:** arquivos JSON em `data/` quando Supabase não está configurado.
- **Criptografia:** AES-256-GCM para tokens Discord, chave derivada de `ENCRYPTION_KEY`.
- **Auth do painel:** e-mail/senha com `scrypt`, sessão por cookie HttpOnly, Discord OAuth, 2FA/TOTP.
- **Selfbot:** `discord.js-selfbot-v13` por contexto de usuário.
- **UI:** HTML/JS estático em `src/ui/`.
- **Testes:** Node test runner (`node --test "test/**/*.test.js"`).

## Entrypoint e boot

### `index.js`

Fluxo de inicialização:

1. Carrega `.env` local via `process.loadEnvFile()` quando disponível.
2. Cria/sincroniza `config.json` via `src/config/configuracao.js`.
3. Inicializa Discord Rich Presence (`src/services/rpc.js`) de forma não bloqueante.
4. Sobe o painel web com `iniciarServidorWebUI()`.
5. Reconnecta sessões/selfs salvos com `reconectarSessoesSalvas()`.
6. Abre navegador local quando aplicável.

O processo é stateful: contextos Discord, sessões em memória, caches e tarefas rodam dentro do mesmo processo Node.

## Layout de diretórios

```text
.
├── index.js                         # Entry point
├── package.json                     # Scripts/deps/build pkg
├── biome.json                       # Formatter/linter Biome
├── railway.json / nixpacks.toml     # Deploy Railway/Nixpacks
├── DEPLOY.md                        # Guia de deploy
├── docs/                            # Planos/specs e esta documentação
├── extensao-discord/                # Extensão Chromium para abrir Discord web com token salvo
├── scripts/                         # Scripts operacionais, ex: reset 2FA
├── src/
│   ├── config/                      # Config local e constantes
│   ├── features/                    # Funções CLI/selfbot antigas ou compartilhadas
│   ├── services/                    # Núcleo web/auth/db/Discord/actions
│   ├── ui/                          # Frontend estático HTML/JS/assets
│   └── utils/                       # Utilitários CLI, background tasks, cores
├── supabase/migrations/             # Migrações do schema Supabase
└── test/                            # Testes node:test
```

## Componentes principais

### Servidor HTTP — `src/services/web-ui-server.js`

Arquivo central do projeto. Responsabilidades:

- Servir HTML estático (`/`, `/login`, `/conta/2fa`, `/admin/auditoria`, assets).
- Definir headers de segurança e CSP.
- Criar/validar sessão do painel.
- Aplicar gate de autenticação, 2FA, admin/super-admin e permissões por feature.
- Implementar endpoints REST do painel.
- Acionar operações de selfbot via `web-actions.js` e contexto do usuário.
- Registrar auditoria em `data/audit.log`.
- Expor healthcheck `/health`/`/healthz`.

Grupos de rotas observados:

- `GET /health`, `/healthz` — healthcheck.
- `/api/auth/site/*` — login do painel, logout, senha, 2FA.
- `/api/auth/discord*` — Discord OAuth para login no painel.
- `/api/admin/*` — usuários, plano pro, feature flags, auditoria, métricas, todos os tokens.
- `/api/auth/*` — conectar/desconectar token Discord/selfbot do usuário.
- `/api/tokens*` — listar/adicionar/remover/usar tokens do próprio usuário.
- `/api/acoes/*` — ações destrutivas/operacionais em Discord: limpar DMs, sair de servidores etc.
- `/api/calls/*`, `/api/automute/*`, `/api/zaralho/*`, `/api/userinfo*` — utilidades avançadas.
- `/api/config`, `/api/aparencia`, `/api/status` — preferências/status.

### Auth do painel — `src/services/auth.js`

Responsabilidades:

- Usuários do painel.
- Hash de senha com `scryptSync` + salt aleatório.
- Sessões com SID aleatório e hash no backend.
- Discord OAuth account linking/criação.
- 2FA/TOTP e códigos de backup.
- Lista de Discord IDs com plano `pro`.
- Feature flags por função (`todos`/`pro`).

Observações importantes:

- Supabase é o backend real de produção.
- Local sem Supabase usa JSON em `data/`, útil para dev, não produção.
- Super-admin é identificado por e-mail fixo no código e/ou `SUPERADMIN_DISCORD_ID` para vínculo por Discord.

### Supabase — `src/services/supabase.js`

Responsabilidades:

- Cliente Supabase com `SUPABASE_SERVICE_ROLE_KEY`.
- CRUD de usuários, sessões, tokens, aparência, permissões e plano pro.
- Tokens Discord ficam cifrados com `crypto.js`.
- O app usa `service_role`, então RLS é bypassado; isolamento depende das queries filtrarem por e-mail.

Tabelas citadas/esperadas pelas migrations:

- `painel_users`
- `painel_user_tokens`
- `painel_sessoes`
- tabelas/colunas incrementais para TOTP, aparência, OAuth Discord, reconexão.

### Criptografia — `src/services/crypto.js`

- Usa AES-256-GCM.
- Deriva chave a partir de `ENCRYPTION_KEY` com `scryptSync`.
- Exige mínimo de 32 bytes na env.
- Tem fallback de chave legacy para decifrar tokens antigos.

Regra operacional: trocar `ENCRYPTION_KEY` invalida tokens já salvos.

### Contexto por usuário — `src/services/user-context.js`

Mantém isolamento runtime por usuário:

- Cliente Discord selfbot do usuário.
- Tokens do usuário.
- Tarefas em background.
- Automute manager.
- Snapshots de auth/status/voz.
- Reconexão de tokens ativos após restart.

Cada usuário deve acessar apenas seus próprios tokens e seu próprio cliente Discord.

### Ações web/selfbot — `src/services/web-actions.js`

Camada chamada pelas rotas `/api/acoes/*`, `/api/calls/*`, `/api/zaralho/*` etc.

Ela adapta as features antigas de CLI para execução via painel web e contexto do usuário.

### Features CLI — `src/features/`

Contém funções históricas/compartilhadas do selfbot:

- `limpar.js`, `dms.js`, `amigos.js`, `servidores.js`
- `backup.js`, `scraper.js`, `clonar.js`
- `calls.js`, `automute.js`, `zaralho.js`
- `comandos-prefix.js`

Algumas funcionalidades são chamadas diretamente pelo painel via services; outras parecem voltadas ao fluxo CLI antigo.

### UI — `src/ui/`

- `login.html` — login por e-mail/senha, Discord OAuth e segunda etapa 2FA.
- `web-ui.html` — painel principal.
- `conta-2fa.html` — gerenciamento de TOTP/códigos backup.
- `auditoria.html`, `backup.html`, `rpc-config.html` — telas auxiliares.
- `vendor/qrcode.min.js` — vendor local para QR de TOTP.
- Assets SVG de marca.

### Extensão Discord — `extensao-discord/`

Extensão Chromium MV3 para abrir Discord web usando um token salvo no painel.

Arquivos principais:

- `manifest.json`
- `content.js` — roda no painel, pede token via `/api/tokens/valor`.
- `background.js` — abre aba Discord e injeta token no `localStorage` do Discord.
- `content-discord.js` — suporte para iframe/embed.
- `rules.json` — remove headers `x-frame-options`/CSP do Discord em sub_frame.

Risco: essa extensão manipula tokens Discord diretamente. Precisa ser tratada como componente altamente sensível.

## Variáveis de ambiente críticas

Referência em `.env.example`:

| Variável | Uso |
|---|---|
| `SUPABASE_URL` | URL do Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend Supabase com bypass de RLS. Segredo crítico. |
| `ENCRYPTION_KEY` | Chave de cifragem dos tokens Discord. Segredo crítico. |
| `PORT` | Porta injetada pelo deploy; local default 4147. |
| `PKTHEGOAT_HOST` | Host bind; produção normalmente `0.0.0.0`. |
| `PKTHEGOAT_SECURE_COOKIES` | Força cookie `Secure`. Deve ficar `1` em HTTPS. |
| `PKTHEGOAT_BASE_URL` | Base pública usada no OAuth Discord. |
| `DISCORD_CLIENT_ID` | OAuth2 Discord. |
| `DISCORD_CLIENT_SECRET` | OAuth2 Discord. Segredo crítico. |
| `DISCORD_REDIRECT_URI` | Override do callback completo. |
| `SUPERADMIN_DISCORD_ID` | Discord ID que vira super-admin ao logar. |
| `TRACKER_API_URL` / `TRACKER_API_KEY` | Integração tracker externa. |

## Segurança: controles existentes

- Cookies de sessão com `HttpOnly` e `SameSite=Lax`; `Secure` em produção/config.
- OAuth Discord usa cookie `state` anti-CSRF.
- Checagem de `Origin` para métodos de estado em host público.
- Rate limit in-memory para operações de token e endpoint de todos os tokens.
- Auditoria de eventos sensíveis sem registrar tokens/senhas.
- Tokens Discord cifrados no banco.
- Endpoint `/api/tokens/buscar-windows` bloqueado em produção.
- Endpoint `/api/admin/all-tokens` exige super-admin + reconfirmação de senha.

## Testes e comandos úteis

```bash
npm test
node --check index.js
npx biome check .
npm audit --omit=dev --audit-level=moderate
node index.js
```

Estado verificado em 2026-07-10:

- `npm test`: passou, 18/18.
- `node --check` em JS rastreado: passou.
- Smoke `/health` com app em porta temporária: HTTP 200 `ok`.
- `npm audit --omit=dev --audit-level=moderate`: 0 vulnerabilidades.
- `npx biome check .`: falha por configuração/formatos existentes, ver achados abaixo.

## Achados atuais / dívida técnica

### 1. `package-lock.json` está ignorado

`.gitignore` ignora `package-lock.json`, mas `nixpacks.toml` tenta `npm ci || npm install`.

Impacto:

- Deploy não determinístico quando cai em `npm install`.
- Versões de dependências podem mudar sem revisão.
- `npm ci` não funciona em clone limpo sem lockfile.

Recomendação: versionar `package-lock.json` e remover essa linha do `.gitignore`, ou assumir explicitamente deploy não determinístico.

### 2. Metadata do `package.json` aponta para repo antigo

Campos atuais apontam para `brunnoxw/brunnoclear`:

- `repository.url`
- `bugs.url`
- `homepage`

Impacto: onboarding e links de issue/README apontam para lugar errado.

Recomendação: trocar para `https://github.com/pkthegoat7/pkthegoat-clear`.

### 3. README ainda documenta repo/nome antigo

O README manda clonar `brunnoxw/brunnoclear` e entrar em `brunnoclear`.

Impacto: novo colaborador clona o projeto errado.

Recomendação: atualizar URLs e comandos para `pkthegoat7/pkthegoat-clear`.

### 4. Biome não está saudável como quality gate

`npx biome check .` falha com:

- schema antigo `1.9.4` vs CLI instalada `2.5.3`;
- campo deprecated `linter.rules.recommended`;
- `data/voice-history.json` analisado apesar de ser dado local ignorado;
- muitos arquivos fora do formato configurado.

Impacto: lint/format não serve como gate confiável atualmente.

Recomendação:

- migrar `biome.json` para Biome 2;
- excluir `data/**`, `node_modules/**`, `dist/**`, `package-lock.json` se necessário;
- rodar formatação em PR separado para evitar misturar com feature.

### 5. Extensão loga tamanho do token no console

`extensao-discord/content.js` faz:

```js
console.log('[selfExt] token obtido (', token.length, 'chars)');
```

Não imprime o token, mas confirma presença/tamanho de segredo no console.

Impacto: baixo/médio; reduz higiene de segredo em componente sensível.

Recomendação: remover logs de token ou deixar sob flag de debug explícita.

### 6. Endpoint `/api/tokens/valor` devolve token decifrado para a extensão

Esse endpoint é necessário para a feature da extensão, mas aumenta a superfície de exposição de tokens.

Controles existentes: exige sessão e busca apenas token do próprio usuário; audita acesso.

Recomendação antes de mexer nessa área:

- manter endpoint POST;
- manter auditoria;
- avaliar nonce/handshake específico da extensão ou exigir confirmação/reautenticação se o modelo de ameaça incluir XSS/extensão maliciosa.

### 7. `DEPLOY.md` está parcialmente desatualizado

Exemplos:

- diz `NODE_VERSION=20`, mas `package.json` exige Node >=22 e Nixpacks usa Node 22;
- limitações dizem “sem MFA”, mas o projeto já tem TOTP/2FA;
- menciona senha inicial em logs, mas o código atual grava credencial inicial em arquivo restrito e evita stdout.

Impacto: onboarding/deploy incorreto.

Recomendação: atualizar DEPLOY em PR de documentação.

## Fluxo recomendado para nova função

1. Definir se a função é:
   - ação de selfbot (`web-actions.js` + talvez `src/features/*`),
   - rota/admin (`web-ui-server.js` + `auth.js`/`supabase.js`),
   - UI (`web-ui.html`/página específica),
   - persistência (`supabase/migrations` + fallback local se aplicável).
2. Adicionar gate de permissão em `FEATURES` se a função for controlável por plano `todos/pro`.
3. Validar inputs na borda (`web-ui-server.js`) antes de chamar serviços.
4. Não logar tokens, secrets, cookies ou payload sensível.
5. Se gravar estado: implementar Supabase e decidir se precisa fallback local em `data/`.
6. Escrever teste com `node:test` para lógica pura ou regressão de bug.
7. Rodar:

```bash
npm test
node --check <arquivos alterados>
npm audit --omit=dev --audit-level=moderate
```

8. Só usar `npx biome check .` como gate depois de corrigir/migrar o Biome.

## Notas de escopo/risco

Este projeto opera selfbot e tokens Discord. Isso viola ToS do Discord e manipula dados altamente sensíveis. Qualquer função nova precisa ser revisada com foco em:

- vazamento de tokens;
- autorização entre usuários;
- bypass de 2FA/admin/super-admin;
- CSRF/XSS;
- logs e auditoria;
- ações destrutivas em massa no Discord;
- uso indevido de `service_role` no Supabase.
