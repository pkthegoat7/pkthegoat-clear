# 2FA (TOTP) do painel pkthegoat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar 2FA por TOTP ao painel web do pkthegoat — obrigatório para o super-admin, opcional para os demais, com códigos de backup e escape via servidor, sem editar o SPA minificado.

**Architecture:** Novo módulo `totp.js` (RFC 6238 com `crypto` nativo, sem dep). Segredo TOTP cifrado com o `crypto.js` existente (AES-256-GCM) e guardado em novas colunas da tabela Supabase `painel_users`. Login vira 2 fases: senha → desafio efêmero → verificação TOTP/backup. Super-admin sem 2FA é barrado por um gate espelhando o de `senhaPrecisaTroca`. Toda a UI nova vive em páginas standalone limpas (`/login`, `/conta/2fa`), e o servidor redireciona `/` → `/login` quando não há sessão ou o 2FA está pendente.

**Tech Stack:** Node 22 (`crypto`, `node:test`), Supabase (`@supabase/supabase-js`), HTTP puro. QR no cliente via lib vendorizada (qrcode-generator, MIT) com fallback de entrada manual do segredo.

**Spec:** `docs/superpowers/specs/2026-06-21-pkthegoat-2fa-totp-design.md`

---

## File Structure

- **Create** `src/services/totp.js` — base32, geração/verificação TOTP (RFC 6238), montagem do URI `otpauth://`.
- **Create** `test/totp.test.js` — vetores oficiais RFC 6238 + base32 roundtrip.
- **Create** `test/auth-2fa.test.js` — códigos de backup + store de desafios (helpers puros).
- **Modify** `src/services/supabase.js` — `atualizarTotp(email, patch)`.
- **Modify** `src/services/auth.js` — wrappers de cifragem do segredo, códigos de backup, store de desafios, e exposição de `totpAtivado`/`precisa2fa` em `buscarUsuario`/`validarSessao`.
- **Modify** `src/services/web-ui-server.js` — login 2 fases, rota `/api/auth/site/2fa`, endpoints de gestão, gate do super-admin, `/me` estendido, servir `/login` + `/conta/2fa` + vendor QR, redirect de `/`.
- **Create** `src/ui/login.html` — login + desafio 2FA + enrollment forçado.
- **Create** `src/ui/conta-2fa.html` — gestão voluntária de 2FA.
- **Create** `src/ui/vendor/qrcode.min.js` — lib QR vendorizada (MIT).
- **Create** `scripts/2fa-reset.js` — escape hatch CLI.
- **Create** `supabase/migrations/2026-06-21-2fa-totp.sql` — colunas novas.
- **Modify** `package.json` — script `test`, registrar UIs novas em `pkg.assets`.

---

## Task 0: Infra de teste + migration

**Files:**
- Modify: `package.json` (scripts + pkg.assets)
- Create: `supabase/migrations/2026-06-21-2fa-totp.sql`

- [ ] **Step 1: Adicionar script de teste**

Em `package.json`, dentro de `"scripts"`, adicionar a chave `"test"`:

```json
"test": "node --test test/"
```

- [ ] **Step 2: Registrar as novas páginas em pkg.assets**

Em `package.json`, no array `pkg.assets`, garantir que existam as entradas (acrescentar as que faltarem):

```json
"src/ui/login.html",
"src/ui/conta-2fa.html",
"src/ui/vendor/qrcode.min.js"
```

- [ ] **Step 3: Escrever a migration SQL**

Criar `supabase/migrations/2026-06-21-2fa-totp.sql`:

```sql
-- 2FA (TOTP) para o painel pkthegoat.
-- Colunas nullable / com default: usuários existentes ficam sem 2FA (sem quebra).
alter table public.painel_users
  add column if not exists totp_secret_cifrado text,
  add column if not exists totp_ativado boolean not null default false,
  add column if not exists totp_backup_codes jsonb,
  add column if not exists totp_ativado_em timestamptz;
```

- [ ] **Step 4: Aplicar a migration no Supabase**

Aplicar via Supabase MCP `apply_migration` (nome `2fa_totp`, o SQL acima) **ou** colar o SQL no SQL Editor do projeto. Depois confirmar com `list_tables` que as 4 colunas existem em `painel_users`.

- [ ] **Step 5: Commit**

```bash
git add package.json supabase/migrations/2026-06-21-2fa-totp.sql
git commit -m "chore(2fa): script de teste, pkg assets e migration das colunas TOTP"
```

---

## Task 1: Módulo `totp.js` (TDD)

**Files:**
- Create: `src/services/totp.js`
- Test: `test/totp.test.js`

- [ ] **Step 1: Escrever os testes que falham**

Criar `test/totp.test.js`. Vetores oficiais do RFC 6238 (seed ASCII `"12345678901234567890"`, base32 `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`), truncados para 6 dígitos:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const totp = require('../src/services/totp');

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 de "12345678901234567890"

test('base32 roundtrip', () => {
    const original = Buffer.from('12345678901234567890', 'utf8');
    assert.strictEqual(totp.base32Encode(original), SECRET);
    assert.ok(totp.base32Decode(SECRET).equals(original));
});

test('vetores RFC 6238 (6 dígitos, SHA1, passo 30s)', () => {
    const casos = [
        [59, '287082'],
        [1111111109, '081804'],
        [1111111111, '050471'],
        [1234567890, '005924'],
        [2000000000, '279037'],
    ];
    for (const [segundos, esperado] of casos) {
        assert.strictEqual(totp.codigoTotp(SECRET, segundos * 1000), esperado, `t=${segundos}`);
    }
});

test('verificar aceita o código atual e rejeita um errado', () => {
    const t = 1111111111 * 1000;
    assert.strictEqual(totp.verificar(SECRET, '050471', t), true);
    assert.strictEqual(totp.verificar(SECRET, '000000', t), false);
});

test('verificar tolera janela de ±1 passo (clock skew)', () => {
    const t = 1111111111 * 1000;
    const anterior = totp.codigoTotp(SECRET, t - 30 * 1000);
    const seguinte = totp.codigoTotp(SECRET, t + 30 * 1000);
    assert.strictEqual(totp.verificar(SECRET, anterior, t), true);
    assert.strictEqual(totp.verificar(SECRET, seguinte, t), true);
});

test('verificar rejeita formato inválido', () => {
    assert.strictEqual(totp.verificar(SECRET, '12', Date.now()), false);
    assert.strictEqual(totp.verificar(SECRET, 'abcdef', Date.now()), false);
    assert.strictEqual(totp.verificar(SECRET, null, Date.now()), false);
});

test('montarUri gera otpauth válido', () => {
    const uri = totp.montarUri('user@x.com', SECRET);
    assert.ok(uri.startsWith('otpauth://totp/pkthegoat:user%40x.com?'));
    assert.ok(uri.includes(`secret=${SECRET}`));
    assert.ok(uri.includes('issuer=pkthegoat'));
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/totp.test.js`
Expected: FAIL — `Cannot find module '../src/services/totp'`.

- [ ] **Step 3: Implementar `totp.js`**

Criar `src/services/totp.js`:

```js
/**
 * TOTP (RFC 6238) com crypto nativo — sem dependência externa.
 * HMAC-SHA1, passo de 30s, 6 dígitos. Segredo em base32 (compatível com otpauth://).
 */
const { createHmac, randomBytes, timingSafeEqual } = require('crypto');

const BASE32_ALFA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
    let bits = 0, valor = 0, saida = '';
    for (const byte of buf) {
        valor = (valor << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            saida += BASE32_ALFA[(valor >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) saida += BASE32_ALFA[(valor << (5 - bits)) & 31];
    return saida;
}

function base32Decode(str) {
    const limpo = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
    let bits = 0, valor = 0;
    const bytes = [];
    for (const ch of limpo) {
        const idx = BASE32_ALFA.indexOf(ch);
        if (idx === -1) throw new Error('Base32 inválido');
        valor = (valor << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((valor >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

function gerarSegredo(bytes = 20) {
    return base32Encode(randomBytes(bytes));
}

function gerarCodigo(secretBase32, contador) {
    const chave = base32Decode(secretBase32);
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(contador / 0x100000000), 0);
    buf.writeUInt32BE(contador >>> 0, 4);
    const hmac = createHmac('sha1', chave).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const bin = ((hmac[offset] & 0x7f) << 24)
        | ((hmac[offset + 1] & 0xff) << 16)
        | ((hmac[offset + 2] & 0xff) << 8)
        | (hmac[offset + 3] & 0xff);
    return String(bin % 1000000).padStart(6, '0');
}

function codigoTotp(secretBase32, tMs = Date.now(), passo = 30) {
    return gerarCodigo(secretBase32, Math.floor((tMs / 1000) / passo));
}

function verificar(secretBase32, codigo, tMs = Date.now(), janela = 1, passo = 30) {
    if (!/^\d{6}$/.test(String(codigo || ''))) return false;
    const contadorBase = Math.floor((tMs / 1000) / passo);
    const alvo = Buffer.from(String(codigo));
    for (let i = -janela; i <= janela; i++) {
        const esperado = Buffer.from(gerarCodigo(secretBase32, contadorBase + i));
        if (esperado.length === alvo.length && timingSafeEqual(esperado, alvo)) return true;
    }
    return false;
}

function montarUri(email, secretBase32, emissor = 'pkthegoat') {
    const label = encodeURIComponent(`${emissor}:${email}`);
    const params = new URLSearchParams({
        secret: secretBase32, issuer: emissor, algorithm: 'SHA1', digits: '6', period: '30'
    });
    return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = { base32Encode, base32Decode, gerarSegredo, gerarCodigo, codigoTotp, verificar, montarUri };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/totp.test.js`
Expected: PASS (todos os testes verdes).

- [ ] **Step 5: Commit**

```bash
git add src/services/totp.js test/totp.test.js
git commit -m "feat(2fa): modulo TOTP (RFC 6238) com crypto nativo + testes"
```

---

## Task 2: Helpers de backup e desafio em `auth.js` (TDD)

**Files:**
- Modify: `src/services/auth.js`
- Test: `test/auth-2fa.test.js`

- [ ] **Step 1: Escrever os testes que falham**

Criar `test/auth-2fa.test.js` (define `ENCRYPTION_KEY` antes de requerer `auth`, pois os wrappers usam `crypto.js`):

```js
process.env.ENCRYPTION_KEY = 'chave-de-teste-com-mais-de-32-bytes-aaaaaaaa';
const { test } = require('node:test');
const assert = require('node:assert');
const auth = require('../src/services/auth');
const totp = require('../src/services/totp');

test('gerarCodigosBackup gera N códigos com hashes correspondentes', () => {
    const { codigos, hashes } = auth.gerarCodigosBackup(10);
    assert.strictEqual(codigos.length, 10);
    assert.strictEqual(hashes.length, 10);
    assert.ok(codigos.every((c) => /^[0-9a-f]{10}$/.test(c)));
});

test('verificarCodigoBackup valida e consome um código (uso único)', () => {
    const { codigos, hashes } = auth.gerarCodigosBackup(3);
    const r1 = auth.verificarCodigoBackup(codigos[1], hashes);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.hashesRestantes.length, 2);
    // o mesmo código não funciona mais contra os hashes restantes
    const r2 = auth.verificarCodigoBackup(codigos[1], r1.hashesRestantes);
    assert.strictEqual(r2.ok, false);
});

test('verificarCodigoBackup rejeita código inexistente', () => {
    const { hashes } = auth.gerarCodigosBackup(3);
    assert.strictEqual(auth.verificarCodigoBackup('zzzzzzzzzz', hashes).ok, false);
});

test('cifrar/decifrar segredo TOTP roundtrip', () => {
    const segredo = totp.gerarSegredo();
    const blob = auth.cifrarSegredoTotp(segredo);
    assert.notStrictEqual(blob, segredo); // está cifrado
    assert.strictEqual(auth.decifrarSegredoTotp(blob), segredo);
});

test('desafio 2FA: cria, obtém, conta tentativas e expira no cap', () => {
    const id = auth.criarDesafio2fa('User@X.com');
    const d = auth.obterDesafio2fa(id);
    assert.strictEqual(d.email, 'user@x.com');
    for (let i = 0; i < 5; i++) auth.registrarTentativaDesafio(id);
    assert.strictEqual(auth.obterDesafio2fa(id), null); // invalidado no cap de 5
});

test('desafio 2FA: consumir remove o desafio', () => {
    const id = auth.criarDesafio2fa('a@b.com');
    auth.consumirDesafio2fa(id);
    assert.strictEqual(auth.obterDesafio2fa(id), null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/auth-2fa.test.js`
Expected: FAIL — `auth.gerarCodigosBackup is not a function`.

- [ ] **Step 3: Implementar os helpers em `auth.js`**

No topo de `src/services/auth.js`, junto aos outros `require`, adicionar:

```js
const totp = require('./totp');
const cripto = require('./crypto');
```

Antes do bloco `module.exports`, adicionar:

```js
// ====================== 2FA: BACKUP CODES ======================
function gerarCodigosBackup(n = 10) {
    const codigos = [];
    const hashes = [];
    for (let i = 0; i < n; i++) {
        const c = randomBytes(5).toString('hex'); // 10 chars hex
        codigos.push(c);
        hashes.push(hashSenha(c)); // mesmo esquema scrypt das senhas
    }
    return { codigos, hashes };
}

function verificarCodigoBackup(codigo, hashes) {
    const c = String(codigo || '').trim().toLowerCase();
    const lista = Array.isArray(hashes) ? hashes : [];
    for (let i = 0; i < lista.length; i++) {
        if (verificarSenha(c, lista[i])) {
            return { ok: true, hashesRestantes: lista.slice(0, i).concat(lista.slice(i + 1)) };
        }
    }
    return { ok: false, hashesRestantes: lista };
}

// ====================== 2FA: SEGREDO CIFRADO ======================
// O segredo base32 é cifrado com o mesmo AES-256-GCM dos tokens Discord e
// guardado como string JSON em painel_users.totp_secret_cifrado.
function cifrarSegredoTotp(segredoBase32) {
    return JSON.stringify(cripto.cifrarToken(segredoBase32));
}
function decifrarSegredoTotp(blob) {
    return cripto.decifrarToken(JSON.parse(blob));
}

// ====================== 2FA: DESAFIOS (in-memory) ======================
const desafios2fa = new Map();
const DESAFIO_TTL_MS = 5 * 60 * 1000;
const DESAFIO_MAX_TENT = 5;

function criarDesafio2fa(email) {
    const id = randomBytes(32).toString('base64url');
    desafios2fa.set(id, { email: emailNormalizado(email), criadoEm: Date.now(), tentativas: 0 });
    return id;
}
function obterDesafio2fa(id) {
    const d = desafios2fa.get(id);
    if (!d) return null;
    if (Date.now() - d.criadoEm > DESAFIO_TTL_MS) { desafios2fa.delete(id); return null; }
    return d;
}
function registrarTentativaDesafio(id) {
    const d = desafios2fa.get(id);
    if (!d) return;
    d.tentativas += 1;
    if (d.tentativas >= DESAFIO_MAX_TENT) desafios2fa.delete(id);
}
function consumirDesafio2fa(id) {
    desafios2fa.delete(id);
}
```

Adicionar todos esses nomes ao objeto `module.exports`:

```js
    gerarCodigosBackup,
    verificarCodigoBackup,
    cifrarSegredoTotp,
    decifrarSegredoTotp,
    criarDesafio2fa,
    obterDesafio2fa,
    registrarTentativaDesafio,
    consumirDesafio2fa,
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/auth-2fa.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/auth.js test/auth-2fa.test.js
git commit -m "feat(2fa): backup codes, cifragem do segredo e store de desafios em auth"
```

---

## Task 3: Expor estado de 2FA em `buscarUsuario`/`validarSessao` + data access Supabase

**Files:**
- Modify: `src/services/auth.js` (`buscarUsuario`, `validarSessao`)
- Modify: `src/services/supabase.js` (`atualizarTotp` + export)

- [ ] **Step 1: Adicionar `atualizarTotp` ao `supabase.js`**

Em `src/services/supabase.js`, após `atualizarSenha`, adicionar:

```js
// Atualiza campos de 2FA. patch aceita: totpSecretCifrado, totpAtivado,
// totpBackupCodes (array), totpAtivadoEm (ISO string|null). Só toca nas chaves presentes.
async function atualizarTotp(email, patch) {
    const sb = obterCliente();
    if (!sb) return { sucesso: false, mensagem: 'Supabase não configurado' };
    const cols = {};
    if ('totpSecretCifrado' in patch) cols.totp_secret_cifrado = patch.totpSecretCifrado;
    if ('totpAtivado' in patch) cols.totp_ativado = !!patch.totpAtivado;
    if ('totpBackupCodes' in patch) cols.totp_backup_codes = patch.totpBackupCodes;
    if ('totpAtivadoEm' in patch) cols.totp_ativado_em = patch.totpAtivadoEm;
    const { data, error } = await filtroEmail(sb.from('painel_users').update(cols), email).select();
    if (error) return { sucesso: false, mensagem: error.message };
    if (!data || data.length === 0) return { sucesso: false, mensagem: 'Usuário não encontrado' };
    return { sucesso: true };
}
```

Adicionar `atualizarTotp` ao `module.exports` de `supabase.js`.

- [ ] **Step 2: Estender `buscarUsuario` (branch Supabase) em `auth.js`**

Em `src/services/auth.js`, no retorno do branch `usarSupabase()` de `buscarUsuario`, acrescentar os campos de 2FA (logo após `senhaPrecisaTroca`):

```js
            senhaPrecisaTroca: !u.senha_alterada_em,
            totpAtivado: !!u.totp_ativado,
            totpSecretCifrado: u.totp_secret_cifrado || null,
            backupCodes: Array.isArray(u.totp_backup_codes) ? u.totp_backup_codes : [],
            precisa2fa: emailNormalizado(u.email) === ADMIN_EMAIL_DEFAULT && !u.totp_ativado
```

E no branch local (final de `buscarUsuario`), trocar:

```js
    return { ...u, senhaPrecisaTroca: !u.senhaAlteradaEm };
```

por:

```js
    return {
        ...u,
        senhaPrecisaTroca: !u.senhaAlteradaEm,
        totpAtivado: !!u.totpAtivado,
        totpSecretCifrado: u.totpSecretCifrado || null,
        backupCodes: Array.isArray(u.totpBackupCodes) ? u.totpBackupCodes : [],
        precisa2fa: emailNormalizado(u.email) === ADMIN_EMAIL_DEFAULT && !u.totpAtivado
    };
```

- [ ] **Step 3: Propagar para `validarSessao`**

Em `src/services/auth.js`, no retorno final de `validarSessao`, acrescentar os campos:

```js
    return {
        email: u.email,
        isAdmin: !!u.isAdmin,
        senhaPrecisaTroca: !!u.senhaPrecisaTroca,
        totpAtivado: !!u.totpAtivado,
        precisa2fa: !!u.precisa2fa
    };
```

- [ ] **Step 4: Sanity check — nada quebrou nos testes existentes**

Run: `node --test test/`
Expected: PASS (Task 1 e 2 continuam verdes; nenhum teste novo aqui — é integração com DB, verificada manualmente na Task 7).

- [ ] **Step 5: Commit**

```bash
git add src/services/auth.js src/services/supabase.js
git commit -m "feat(2fa): expor estado TOTP em buscarUsuario/validarSessao + atualizarTotp"
```

---

## Task 4: Login em 2 fases + verificação `/api/auth/site/2fa`

**Files:**
- Modify: `src/services/web-ui-server.js` (imports, handler de login, nova rota, `ROTAS_PUBLICAS`)

- [ ] **Step 1: Importar os novos helpers de `auth`**

Em `src/services/web-ui-server.js`, no bloco de desestruturação do `require('./auth')` (por volta da linha 12), acrescentar:

```js
    criarDesafio2fa,
    obterDesafio2fa,
    registrarTentativaDesafio,
    consumirDesafio2fa,
    decifrarSegredoTotp,
    verificarCodigoBackup,
    buscarUsuario,
```

E adicionar no topo: `const totp = require('./totp');` e `const supa = require('./supabase');` (este último já existe — não duplicar).

- [ ] **Step 2: Tornar o login 2 fases**

Em `handleApi`, substituir o trecho atual que cria a sessão no sucesso do login:

```js
        if (!r.sucesso) return jsonResponse(res, 401, r);
        const sid = criarSessao(r.usuario.email);
        setSessionCookie(res, sid);
        return jsonResponse(res, 200, { sucesso: true, usuario: r.usuario });
```

por:

```js
        if (!r.sucesso) return jsonResponse(res, 401, r);
        // Se o usuário tem 2FA ativo, não cria sessão ainda: emite um desafio.
        const u2fa = await buscarUsuario(r.usuario.email);
        if (u2fa && u2fa.totpAtivado) {
            const desafio = criarDesafio2fa(r.usuario.email);
            registrarAuditoria(req, emailTentado, 'login.sucesso', { etapa: '2fa-pendente' });
            return jsonResponse(res, 200, { sucesso: true, etapa: '2fa', desafio });
        }
        const sid = criarSessao(r.usuario.email);
        setSessionCookie(res, sid);
        return jsonResponse(res, 200, { sucesso: true, usuario: r.usuario });
```

- [ ] **Step 3: Registrar a rota pública `/api/auth/site/2fa`**

Alterar a linha:

```js
const ROTAS_PUBLICAS = new Set(['/api/auth/site/login']);
```

para:

```js
const ROTAS_PUBLICAS = new Set(['/api/auth/site/login', '/api/auth/site/2fa']);
```

- [ ] **Step 4: Implementar o handler do desafio**

Em `handleApi`, logo após o bloco `if (req.method === 'POST' && url === '/api/auth/site/login') { ... }`, adicionar:

```js
    if (req.method === 'POST' && url === '/api/auth/site/2fa') {
        const body = await lerJsonBody(req);
        const desafio = obterDesafio2fa(String(body.desafio || ''));
        if (!desafio) {
            return jsonResponse(res, 401, { sucesso: false, mensagem: 'Desafio inválido ou expirado. Faça login novamente.' });
        }
        // Rate-limit por IP, igual ao login.
        const chave = chaveRateLimit(req, desafio.email);
        if (loginBloqueado(req, chave)) {
            registrarAuditoria(req, desafio.email, 'login.bloqueado', { fase: '2fa' });
            return jsonResponse(res, 429, { sucesso: false, mensagem: 'Muitas tentativas. Tente novamente em alguns minutos.' });
        }
        const codigo = String(body.codigo || '').trim();
        const usuario = await buscarUsuario(desafio.email);
        if (!usuario || !usuario.totpAtivado || !usuario.totpSecretCifrado) {
            consumirDesafio2fa(body.desafio);
            return jsonResponse(res, 401, { sucesso: false, mensagem: 'Configuração de 2FA inválida.' });
        }
        let ok = false;
        let viaBackup = false;
        try {
            ok = totp.verificar(decifrarSegredoTotp(usuario.totpSecretCifrado), codigo);
        } catch { ok = false; }
        if (!ok) {
            const rb = verificarCodigoBackup(codigo, usuario.backupCodes);
            if (rb.ok) {
                ok = true;
                viaBackup = true;
                await supa.atualizarTotp(desafio.email, { totpBackupCodes: rb.hashesRestantes });
            }
        }
        registrarTentativaLogin(req, chave, ok);
        registrarTentativaDesafio(body.desafio);
        if (!ok) {
            registrarAuditoria(req, desafio.email, 'login.falha', { fase: '2fa' });
            return jsonResponse(res, 401, { sucesso: false, mensagem: 'Código inválido' });
        }
        consumirDesafio2fa(body.desafio);
        registrarAuditoria(req, desafio.email, viaBackup ? '2fa.backup.usado' : '2fa.login.sucesso', {});
        const sid = criarSessao(desafio.email);
        setSessionCookie(res, sid);
        return jsonResponse(res, 200, { sucesso: true, usuario: { email: usuario.email, isAdmin: !!usuario.isAdmin } });
    }
```

- [ ] **Step 5: Smoke test de carga do módulo**

Run: `node -e "require('./src/services/web-ui-server')" `
Expected: sem erro de sintaxe/require (o módulo carrega; não inicia servidor).

- [ ] **Step 6: Commit**

```bash
git add src/services/web-ui-server.js
git commit -m "feat(2fa): login em 2 fases + verificacao de codigo TOTP/backup"
```

---

## Task 5: Endpoints de gestão + gate do super-admin + `/me` estendido

**Files:**
- Modify: `src/services/web-ui-server.js`

- [ ] **Step 1: Estender o `/api/auth/site/me`**

No handler `GET /api/auth/site/me`, dentro do objeto `usuario`, acrescentar campos de 2FA. Trocar o retorno por:

```js
    if (req.method === 'GET' && url === '/api/auth/site/me') {
        const u = await buscarUsuario(sessao.email);
        return jsonResponse(res, 200, {
            sucesso: true,
            usuario: {
                email: sessao.email,
                isAdmin: sessao.isAdmin,
                isSuperAdmin: ehSuperAdmin(sessao.email),
                senhaPrecisaTroca: !!sessao.senhaPrecisaTroca,
                totpAtivado: !!(u && u.totpAtivado),
                precisa2fa: !!(u && u.precisa2fa),
                backupRestantes: u && Array.isArray(u.backupCodes) ? u.backupCodes.length : 0
            }
        });
    }
```

- [ ] **Step 2: Adicionar o gate do super-admin**

Localizar o gate existente de `senhaPrecisaTroca` (constante `ROTAS_PERMITIDAS_SEM_TROCA` + o `if (sessao.senhaPrecisaTroca && ...)`). Logo **depois** desse `if`, adicionar o gate de 2FA:

```js
    const ROTAS_PERMITIDAS_SEM_2FA = new Set([
        '/api/auth/site/me',
        '/api/auth/site/logout',
        '/api/auth/site/2fa/setup',
        '/api/auth/site/2fa/ativar'
    ]);
    if (sessao.precisa2fa && !ROTAS_PERMITIDAS_SEM_2FA.has(url)) {
        return jsonResponse(res, 403, { sucesso: false, mensagem: '2FA obrigatório. Configure em /conta/2fa.', precisa2fa: true });
    }
```

- [ ] **Step 3: Endpoint de setup (gera segredo)**

Após o handler do `/api/auth/site/password`, adicionar:

```js
    if (req.method === 'POST' && url === '/api/auth/site/2fa/setup') {
        const segredo = totp.gerarSegredo();
        const r = await supa.atualizarTotp(sessao.email, {
            totpSecretCifrado: cifrarSegredoTotp(segredo),
            totpAtivado: false
        });
        if (!r.sucesso) return jsonResponse(res, 500, r);
        registrarAuditoria(req, sessao.email, '2fa.setup', {});
        return jsonResponse(res, 200, {
            sucesso: true,
            secret: segredo,
            uri: totp.montarUri(sessao.email, segredo)
        });
    }
```

Adicionar `cifrarSegredoTotp` e `gerarCodigosBackup` à lista de imports do `require('./auth')` (Task 4, Step 1).

- [ ] **Step 4: Endpoint de ativação (confirma + gera backup codes)**

```js
    if (req.method === 'POST' && url === '/api/auth/site/2fa/ativar') {
        const body = await lerJsonBody(req);
        const u = await buscarUsuario(sessao.email);
        if (!u || !u.totpSecretCifrado) {
            return jsonResponse(res, 400, { sucesso: false, mensagem: 'Inicie o setup primeiro.' });
        }
        let ok = false;
        try { ok = totp.verificar(decifrarSegredoTotp(u.totpSecretCifrado), String(body.codigo || '').trim()); }
        catch { ok = false; }
        if (!ok) return jsonResponse(res, 401, { sucesso: false, mensagem: 'Código inválido' });
        const { codigos, hashes } = gerarCodigosBackup(10);
        const r = await supa.atualizarTotp(sessao.email, {
            totpAtivado: true,
            totpAtivadoEm: new Date().toISOString(),
            totpBackupCodes: hashes
        });
        if (!r.sucesso) return jsonResponse(res, 500, r);
        registrarAuditoria(req, sessao.email, '2fa.ativado', {});
        return jsonResponse(res, 200, { sucesso: true, backupCodes: codigos });
    }
```

- [ ] **Step 5: Endpoint de desativação (bloqueado p/ super-admin) + regenerar backup**

```js
    if (req.method === 'POST' && url === '/api/auth/site/2fa/desativar') {
        if (ehSuperAdmin(sessao.email)) {
            return jsonResponse(res, 403, { sucesso: false, mensagem: '2FA é obrigatório para o super-admin.' });
        }
        const body = await lerJsonBody(req);
        if (!body.senha || !(await reconfirmarSenha(sessao.email, body.senha))) {
            return jsonResponse(res, 401, { sucesso: false, mensagem: 'Senha inválida' });
        }
        const r = await supa.atualizarTotp(sessao.email, {
            totpSecretCifrado: null, totpAtivado: false, totpBackupCodes: null, totpAtivadoEm: null
        });
        if (!r.sucesso) return jsonResponse(res, 500, r);
        registrarAuditoria(req, sessao.email, '2fa.desativado', {});
        return jsonResponse(res, 200, { sucesso: true });
    }

    if (req.method === 'POST' && url === '/api/auth/site/2fa/backup/regenerar') {
        const body = await lerJsonBody(req);
        if (!body.senha || !(await reconfirmarSenha(sessao.email, body.senha))) {
            return jsonResponse(res, 401, { sucesso: false, mensagem: 'Senha inválida' });
        }
        const u = await buscarUsuario(sessao.email);
        if (!u || !u.totpAtivado) return jsonResponse(res, 400, { sucesso: false, mensagem: '2FA não está ativo.' });
        const { codigos, hashes } = gerarCodigosBackup(10);
        const r = await supa.atualizarTotp(sessao.email, { totpBackupCodes: hashes });
        if (!r.sucesso) return jsonResponse(res, 500, r);
        registrarAuditoria(req, sessao.email, '2fa.backup.regenerado', {});
        return jsonResponse(res, 200, { sucesso: true, backupCodes: codigos });
    }
```

`reconfirmarSenha` já é importado de `auth` (usado em `/api/auth/site/password`) — confirmar que está na lista de imports.

- [ ] **Step 6: Smoke test de carga**

Run: `node -e "require('./src/services/web-ui-server')"`
Expected: sem erro.

- [ ] **Step 7: Commit**

```bash
git add src/services/web-ui-server.js
git commit -m "feat(2fa): endpoints de gestao (setup/ativar/desativar/backup) + gate super-admin"
```

---

## Task 6: Páginas `/login` e `/conta/2fa`, vendor do QR e redirect de `/`

**Files:**
- Modify: `src/services/web-ui-server.js` (rotas GET de HTML + vendor + redirect)
- Create: `src/ui/login.html`, `src/ui/conta-2fa.html`, `src/ui/vendor/qrcode.min.js`

- [ ] **Step 1: Vendorizar a lib de QR**

Baixar o arquivo único MIT `qrcode-generator` (Kazuhiko Arase) para `src/ui/vendor/qrcode.min.js`:

```bash
mkdir -p src/ui/vendor
curl -fsSL https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js -o src/ui/vendor/qrcode.min.js
```

Verificar que o arquivo expõe a função global `qrcode(typeNumber, errorCorrectionLevel)`:

```bash
grep -c "function qrcode" src/ui/vendor/qrcode.min.js   # esperado: >= 1
```

- [ ] **Step 2: Servir as rotas GET de HTML + vendor (sem sessão)**

No bloco de rotas GET de HTML (perto de `GET /admin/auditoria`, ~linha 1518), adicionar **antes** do handler de `/`:

```js
    if (req.method === 'GET' && (url === '/login' || url === '/conta/2fa')) {
        const arquivo = url === '/login' ? 'login.html' : 'conta-2fa.html';
        fs.readFile(path.join(__dirname, '..', 'ui', arquivo), (err, data) => {
            if (err) { res.writeHead(500, { 'Content-Type': 'text/plain', ...headersSeguranca() }); res.end('Erro'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headersSeguranca() });
            res.end(data);
        });
        return;
    }
    if (req.method === 'GET' && url === '/ui/vendor/qrcode.min.js') {
        fs.readFile(path.join(__dirname, '..', 'ui', 'vendor', 'qrcode.min.js'), (err, data) => {
            if (err) { res.writeHead(404, { 'Content-Type': 'text/plain', ...headersSeguranca() }); res.end('Not found'); return; }
            res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', ...headersSeguranca() });
            res.end(data);
        });
        return;
    }
```

(`/login` e `/conta/2fa` são GET de HTML e NÃO passam pelo gate de sessão de `handleApi` — são servidos diretamente em `handleRequest`, como `auditoria.html`. A proteção real está nos endpoints `/api/...`.)

- [ ] **Step 3: Redirecionar `/` para `/login` quando sem sessão ou 2FA pendente**

Substituir o handler `GET /` (`url === '/' || url === '/index.html'`) por uma versão que resolve a sessão antes de servir o SPA:

```js
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        const sessao = await resolverSessao(req);
        if (!sessao || sessao.precisa2fa) {
            res.writeHead(302, { Location: '/login', ...headersSeguranca() });
            res.end();
            return;
        }
        fs.readFile(htmlPath(), (err, data) => {
            if (err) { res.writeHead(500, { 'Content-Type': 'text/plain', ...headersSeguranca() }); res.end('Erro ao carregar UI'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headersSeguranca() });
            res.end(data);
        });
        return;
    }
```

Garantir que essa função (`handleRequest`) seja `async` e que a chamada esteja sob `await`. Se `handleRequest` ainda não for `async`, marcá-la `async`.

- [ ] **Step 4: Criar `src/ui/login.html`**

```html
<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login — pkthegoat</title>
<style>
  :root{color-scheme:dark}
  body{font-family:system-ui,sans-serif;background:#0f1115;color:#e8eaed;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:28px;width:340px;max-width:92vw}
  h1{font-size:18px;margin:0 0 16px}
  label{display:block;font-size:13px;margin:12px 0 4px;color:#a8b0bd}
  input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #2c323d;background:#0f1115;color:#e8eaed;font-size:15px}
  button{width:100%;margin-top:16px;padding:11px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-size:15px;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  .erro{color:#f87171;font-size:13px;margin-top:10px;min-height:16px}
  .muted{color:#8b93a1;font-size:12px}
  .hide{display:none}
  .codes{background:#0f1115;border:1px solid #2c323d;border-radius:8px;padding:12px;font-family:monospace;font-size:14px;line-height:1.9;letter-spacing:1px}
  #qr{display:flex;justify-content:center;margin:12px 0}
  #qr img{background:#fff;padding:8px;border-radius:8px}
  a.link{color:#60a5fa;font-size:13px;cursor:pointer}
  code{background:#0f1115;padding:2px 6px;border-radius:4px}
</style>
</head>
<body>
<div class="card">
  <h1>pkthegoat — painel</h1>

  <form id="form-senha">
    <label>E-mail</label>
    <input id="email" type="email" autocomplete="username" required>
    <label>Senha</label>
    <input id="senha" type="password" autocomplete="current-password" required>
    <button type="submit">Entrar</button>
  </form>

  <form id="form-2fa" class="hide">
    <p class="muted">Digite o código de 6 dígitos do seu app autenticador.</p>
    <label>Código</label>
    <input id="codigo" inputmode="numeric" autocomplete="one-time-code" placeholder="000000">
    <button type="submit">Verificar</button>
    <p style="margin-top:10px"><a class="link" id="usar-backup">Usar código de backup</a></p>
  </form>

  <div id="enroll" class="hide">
    <p class="muted">2FA é obrigatório nesta conta. Escaneie o QR no seu app autenticador (ou digite o segredo) e confirme com um código.</p>
    <div id="qr"></div>
    <p class="muted">Segredo: <code id="secret"></code></p>
    <label>Código do app</label>
    <input id="codigo-enroll" inputmode="numeric" placeholder="000000">
    <button id="btn-ativar">Ativar 2FA</button>
  </div>

  <div id="backup" class="hide">
    <p class="muted">Guarde estes códigos de backup num lugar seguro. Cada um funciona uma vez.</p>
    <div class="codes" id="backup-list"></div>
    <button id="btn-continuar">Continuar para o painel</button>
  </div>

  <div class="erro" id="erro"></div>
</div>

<script src="/ui/vendor/qrcode.min.js"></script>
<script>
const $ = (id) => document.getElementById(id);
const erro = (m) => { $('erro').textContent = m || ''; };
let desafioAtual = null;

async function api(url, body) {
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) });
  const j = await r.json().catch(() => ({}));
  return { status:r.status, j };
}
function mostrar(secao){ ['form-senha','form-2fa','enroll','backup'].forEach(s => $(s).classList.toggle('hide', s!==secao)); }

$('form-senha').addEventListener('submit', async (e) => {
  e.preventDefault(); erro('');
  const { status, j } = await api('/api/auth/site/login', { email:$('email').value, senha:$('senha').value });
  if (status === 200 && j.etapa === '2fa') { desafioAtual = j.desafio; mostrar('form-2fa'); $('codigo').focus(); return; }
  if (status === 200 && j.sucesso) { await rotaPosLogin(); return; }
  erro(j.mensagem || 'Falha no login');
});

$('form-2fa').addEventListener('submit', async (e) => {
  e.preventDefault(); erro('');
  const { status, j } = await api('/api/auth/site/2fa', { desafio: desafioAtual, codigo: $('codigo').value });
  if (status === 200 && j.sucesso) { location.href = '/'; return; }
  erro(j.mensagem || 'Código inválido');
  if (status === 401 && /expirad|inválido ou/i.test(j.mensagem||'')) mostrar('form-senha');
});

$('usar-backup').addEventListener('click', () => { $('codigo').placeholder = 'código de backup'; $('codigo').focus(); });

// Pós-login: se a sessão exige enrollment (super-admin), abre o fluxo; senão vai pro painel.
async function rotaPosLogin() {
  const r = await fetch('/api/auth/site/me'); const j = await r.json().catch(()=>({}));
  if (j.usuario && j.usuario.precisa2fa) return iniciarEnroll();
  location.href = '/';
}
async function iniciarEnroll() {
  mostrar('enroll'); erro('');
  const { j } = await api('/api/auth/site/2fa/setup', {});
  if (!j.sucesso) { erro(j.mensagem||'Erro ao iniciar 2FA'); return; }
  $('secret').textContent = j.secret;
  $('qr').innerHTML = '';
  try {
    const qr = qrcode(0, 'M'); qr.addData(j.uri); qr.make();
    $('qr').innerHTML = qr.createImgTag(5, 8);
  } catch { $('qr').innerHTML = '<span class="muted">Use o segredo abaixo para cadastro manual.</span>'; }
}
$('btn-ativar').addEventListener('click', async () => {
  erro('');
  const { status, j } = await api('/api/auth/site/2fa/ativar', { codigo: $('codigo-enroll').value });
  if (status === 200 && j.sucesso) {
    $('backup-list').textContent = j.backupCodes.join('  ');
    mostrar('backup'); return;
  }
  erro(j.mensagem || 'Código inválido');
});
$('btn-continuar').addEventListener('click', () => { location.href = '/'; });

// Se já estiver logado mas com 2FA pendente (super-admin recarregou /login), abre enrollment.
(async () => {
  const r = await fetch('/api/auth/site/me');
  if (r.status === 200) { const j = await r.json(); if (j.usuario && j.usuario.precisa2fa) return iniciarEnroll(); }
})();
</script>
</body>
</html>
```

- [ ] **Step 5: Criar `src/ui/conta-2fa.html`**

```html
<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>2FA — pkthegoat</title>
<style>
  :root{color-scheme:dark}
  body{font-family:system-ui,sans-serif;background:#0f1115;color:#e8eaed;display:flex;min-height:100vh;align-items:flex-start;justify-content:center;margin:0;padding:32px}
  .card{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:28px;width:380px;max-width:92vw}
  h1{font-size:18px;margin:0 0 16px}
  label{display:block;font-size:13px;margin:12px 0 4px;color:#a8b0bd}
  input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #2c323d;background:#0f1115;color:#e8eaed;font-size:15px}
  button{width:100%;margin-top:14px;padding:11px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-size:15px;cursor:pointer}
  button.danger{background:#b91c1c}
  .muted{color:#8b93a1;font-size:12px}
  .erro{color:#f87171;font-size:13px;margin-top:10px;min-height:16px}
  .ok{color:#34d399;font-size:13px;margin-top:10px}
  .hide{display:none}
  .codes{background:#0f1115;border:1px solid #2c323d;border-radius:8px;padding:12px;font-family:monospace;font-size:14px;line-height:1.9}
  #qr{display:flex;justify-content:center;margin:12px 0}
  #qr img{background:#fff;padding:8px;border-radius:8px}
  a.link{color:#60a5fa;font-size:13px}
  code{background:#0f1115;padding:2px 6px;border-radius:4px}
</style>
</head>
<body>
<div class="card">
  <h1>Autenticação de dois fatores</h1>
  <p><a class="link" href="/">← voltar ao painel</a></p>

  <div id="estado" class="muted">Carregando…</div>

  <div id="ativo" class="hide">
    <p class="ok">2FA está ATIVO nesta conta. Códigos de backup restantes: <span id="restantes"></span>.</p>
    <label>Senha (para confirmar)</label>
    <input id="senha-ativo" type="password" autocomplete="current-password">
    <button id="btn-regenerar">Regenerar códigos de backup</button>
    <button id="btn-desativar" class="danger">Desativar 2FA</button>
  </div>

  <div id="setup" class="hide">
    <p class="muted">Escaneie o QR no app autenticador (ou digite o segredo) e confirme com um código.</p>
    <div id="qr"></div>
    <p class="muted">Segredo: <code id="secret"></code></p>
    <label>Código do app</label>
    <input id="codigo" inputmode="numeric" placeholder="000000">
    <button id="btn-ativar">Ativar 2FA</button>
    <button id="btn-iniciar" class="hide">Configurar 2FA</button>
  </div>

  <div id="backup" class="hide">
    <p class="muted">Guarde estes códigos de backup. Cada um funciona uma vez.</p>
    <div class="codes" id="backup-list"></div>
  </div>

  <div class="erro" id="erro"></div>
</div>

<script src="/ui/vendor/qrcode.min.js"></script>
<script>
const $ = (id) => document.getElementById(id);
const erro = (m) => { $('erro').textContent = m || ''; };
async function api(url, body) {
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) });
  return { status:r.status, j: await r.json().catch(()=>({})) };
}
async function carregar() {
  const r = await fetch('/api/auth/site/me');
  if (r.status !== 200) { location.href = '/login'; return; }
  const { usuario } = await r.json();
  $('estado').textContent = usuario.email;
  if (usuario.totpAtivado) {
    $('restantes').textContent = usuario.backupRestantes;
    $('ativo').classList.remove('hide'); $('setup').classList.add('hide');
  } else {
    $('ativo').classList.add('hide'); await iniciarSetup();
  }
}
async function iniciarSetup() {
  $('setup').classList.remove('hide');
  const { j } = await api('/api/auth/site/2fa/setup', {});
  if (!j.sucesso) { erro(j.mensagem||'Erro'); return; }
  $('secret').textContent = j.secret;
  try { const qr = qrcode(0,'M'); qr.addData(j.uri); qr.make(); $('qr').innerHTML = qr.createImgTag(5,8); }
  catch { $('qr').innerHTML = '<span class="muted">Cadastro manual pelo segredo.</span>'; }
}
$('btn-ativar').addEventListener('click', async () => {
  erro('');
  const { status, j } = await api('/api/auth/site/2fa/ativar', { codigo: $('codigo').value });
  if (status === 200 && j.sucesso) {
    $('backup-list').textContent = j.backupCodes.join('  ');
    $('backup').classList.remove('hide'); $('setup').classList.add('hide'); return;
  }
  erro(j.mensagem || 'Código inválido');
});
$('btn-regenerar').addEventListener('click', async () => {
  erro('');
  const { status, j } = await api('/api/auth/site/2fa/backup/regenerar', { senha: $('senha-ativo').value });
  if (status === 200 && j.sucesso) { $('backup-list').textContent = j.backupCodes.join('  '); $('backup').classList.remove('hide'); return; }
  erro(j.mensagem || 'Erro');
});
$('btn-desativar').addEventListener('click', async () => {
  erro('');
  const { status, j } = await api('/api/auth/site/2fa/desativar', { senha: $('senha-ativo').value });
  if (status === 200 && j.sucesso) { location.reload(); return; }
  erro(j.mensagem || 'Erro');
});
carregar();
</script>
</body>
</html>
```

- [ ] **Step 6: Smoke test de carga**

Run: `node -e "require('./src/services/web-ui-server')"`
Expected: sem erro.

- [ ] **Step 7: Commit**

```bash
git add src/services/web-ui-server.js src/ui/login.html src/ui/conta-2fa.html src/ui/vendor/qrcode.min.js
git commit -m "feat(2fa): paginas /login e /conta/2fa, QR vendorizado e redirect de /"
```

---

## Task 7: Escape hatch CLI + verificação manual ponta-a-ponta

**Files:**
- Create: `scripts/2fa-reset.js`

- [ ] **Step 1: Escrever o script de reset**

Criar `scripts/2fa-reset.js`:

```js
#!/usr/bin/env node
/**
 * Escape hatch anti-lockout: desativa o 2FA de uma conta direto no Supabase.
 * Uso (na VPS, com SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ENCRYPTION_KEY no ambiente):
 *   node scripts/2fa-reset.js patricknicoli55@gmail.com
 */
const path = require('path');
const supa = require(path.join(__dirname, '..', 'src', 'services', 'supabase'));

async function main() {
    const email = process.argv[2];
    if (!email) { console.error('Uso: node scripts/2fa-reset.js <email>'); process.exit(1); }
    if (!supa.estaConfigurado()) { console.error('Supabase não configurado (env).'); process.exit(1); }
    const u = await supa.buscarUsuario(email);
    if (!u) { console.error('Usuário não encontrado:', email); process.exit(1); }
    const r = await supa.atualizarTotp(email, {
        totpSecretCifrado: null, totpAtivado: false, totpBackupCodes: null, totpAtivadoEm: null
    });
    if (!r.sucesso) { console.error('Falha:', r.mensagem); process.exit(1); }
    console.log('2FA desativado para', email, '— faça login e reconfigure.');
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Rodar a suíte de testes completa**

Run: `node --test test/`
Expected: PASS em todos os testes (`totp.test.js`, `auth-2fa.test.js`).

- [ ] **Step 3: Verificação manual — fluxo voluntário**

Com as envs reais (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`) carregadas, subir o painel localmente (`node index.js` ou o entrypoint do web-ui) e, com um usuário **não** super-admin:
1. Acessar `/conta/2fa` → escanear QR num app autenticador → digitar código → confirmar.
2. Conferir que os códigos de backup aparecem.
3. Deslogar (`/api/auth/site/logout`) e logar de novo: a senha deve levar à tela de código; o código TOTP entra.
4. Repetir o login usando um **código de backup** → entra e aquele código deixa de funcionar.

Confirmar no `audit.log` os eventos `2fa.setup`, `2fa.ativado`, `2fa.login.sucesso`, `2fa.backup.usado`.

- [ ] **Step 4: Verificação manual — super-admin obrigatório**

Com o super-admin (`patricknicoli55@gmail.com`) **sem** 2FA:
1. Acessar `/` → deve redirecionar para `/login`.
2. Logar com senha → a página deve abrir o enrollment forçado (QR).
3. Tentar chamar uma rota protegida antes de ativar (ex.: `GET /api/admin/auditoria`) → deve retornar `403 { precisa2fa: true }`.
4. Ativar o 2FA → guardar backup codes → cair no painel `/`.

- [ ] **Step 5: Verificação manual — escape hatch**

Rodar `node scripts/2fa-reset.js <email-de-teste>` e confirmar que aquela conta volta a logar só com senha (e o super-admin volta a ser forçado a reconfigurar).

- [ ] **Step 6: Commit**

```bash
git add scripts/2fa-reset.js
git commit -m "feat(2fa): script de escape anti-lockout (reset de 2FA via Supabase)"
```

---

## Notas de deploy

1. Aplicar a migration (Task 0, Step 4) **antes** de subir o código.
2. `ENCRYPTION_KEY` já está setada no Railway (a mesma dos tokens) — o segredo TOTP usa ela. Não rotacionar sem migrar os segredos.
3. Após o deploy, o próximo login do super-admin força o enrollment. Ter o `scripts/2fa-reset.js` à mão na VPS como rede de segurança.
4. O `audit.log` no Railway é efêmero (zera a cada deploy) — comportamento já conhecido, sem mudança.

## Self-review (cobertura do spec)

- Spec §1 (colunas) → Task 0. §2 (`totp.js`) → Task 1. §3 (login 2 fases) → Task 4. §4 (gate super-admin) → Task 5. §5 (endpoints de gestão) → Task 5. §6 (páginas limpas) → Task 6. §7 (escape hatch) → Task 7. §8 (segurança/auditoria) → Tasks 4–6 (rate-limit, scrypt, eventos). §9 (testes) → Tasks 1–2 (unit) + Task 7 (manual, pois rotas HTTP bootam o bot).
- Tipos consistentes: `atualizarTotp(patch)` usa as chaves `totpSecretCifrado/totpAtivado/totpBackupCodes/totpAtivadoEm` em todos os call-sites; `cifrarSegredoTotp/decifrarSegredoTotp` casados; `criarDesafio2fa/obterDesafio2fa/registrarTentativaDesafio/consumirDesafio2fa` usados igual em auth e no servidor.
