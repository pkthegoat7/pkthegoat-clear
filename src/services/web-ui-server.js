const http = require('http');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const {
    inicializarAdminSeNecessario,
    criarUsuario,
    trocarSenha,
    deletarUsuario,
    listarUsuarios,
    autenticar,
    reconfirmarSenha,
    criarSessao,
    validarSessao,
    removerSessao,
    removerTodasSessoesDoUsuario
} = require('./auth');
const {
    obterContexto,
    destruirContexto,
    adicionarTokenUsuario,
    removerTokenUsuario,
    listarTokensUsuario
} = require('./user-context');
const supa = require('./supabase');

// Email do super-admin que vê todos os tokens cadastrados por todos os usuários.
const SUPER_ADMIN_EMAIL = 'patricknicoli55@gmail.com';
const ehSuperAdmin = (email) => String(email || '').trim().toLowerCase() === SUPER_ADMIN_EMAIL;
const {
    removerTodosAmigosWeb,
    removerTodosServidoresWeb,
    fecharTodasDMsWeb,
    limparDMUnicaWeb,
    limparDMsAbertasWeb,
    backupDMWeb,
    scraperIconsWeb,
    desconectarTodosCallWeb,
    moverMembrosCallWeb,
    mutarTodosCallWeb,
    ensurdecerTodosCallWeb,
    listarMembrosCallWeb,
    farmarHorasWeb,
    entrarCallWeb,
    elevadorWeb,
    coleiraWeb,
    protegerUsuarioWeb,
    nicknameBloqueadoWeb,
    blacklistChatWeb,
    antiDMWeb,
    obterHypeSquadWeb,
    mudarHypeSquadWeb
} = require('./web-actions');
const { obterConfig, atualizarConfig } = require('../config/configuracao');
const { validarToken, buscarTokensWindows } = require('./tokens');
const userHistory = require('./user-history');

// Consulta enriquecida em discordlookup.mesalytic.moe (API pública gratuita).
// Não retorna histórico de nomes/avatares, mas confirma badges, banner, accent_color e data de criação.
function consultarLookupHTTPS(host, pathUrl) {
    return new Promise((resolve) => {
        try {
            const https = require('https');
            const req = https.request({
                method: 'GET',
                host,
                path: pathUrl,
                timeout: 4000,
                headers: { 'User-Agent': 'pkthegoat-clear/1.0', 'Accept': 'application/json' }
            }, (resp) => {
                let buf = '';
                resp.on('data', (c) => { buf += c; if (buf.length > 200_000) { resp.destroy(); } });
                resp.on('end', () => {
                    if (resp.statusCode !== 200) return resolve(null);
                    try { resolve(JSON.parse(buf)); } catch { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
            req.end();
        } catch {
            resolve(null);
        }
    });
}

async function consultarLookupExterno(userId) {
    // Tenta a API principal e algumas alternativas até alguma responder.
    const tentativas = [
        () => consultarLookupHTTPS('discordlookup.mesalytic.moe', `/v1/user/${encodeURIComponent(userId)}`),
        () => consultarLookupHTTPS('japi.rest', `/discord/v1/user/${encodeURIComponent(userId)}`).then((d) => d?.data || null),
        () => consultarLookupHTTPS('discordlookup.com', `/api/v1/user/${encodeURIComponent(userId)}`)
    ];
    for (const fn of tentativas) {
        try {
            const r = await fn();
            if (r && (r.id || r.username || r.tag)) return r;
        } catch {}
    }
    return null;
}

// Decode dos campos do snowflake do Discord. Epoch = 2015-01-01.
function decodificarSnowflake(idStr) {
    if (!/^\d{17,20}$/.test(String(idStr))) return null;
    const id = BigInt(idStr);
    const ts = Number(id >> 22n) + 1420070400000;
    return {
        timestamp: new Date(ts).toISOString(),
        internalWorker: Number((id & 0x3E0000n) >> 17n),
        internalProcess: Number((id & 0x1F000n) >> 12n),
        increment: Number(id & 0xFFFn)
    };
}

// URLs diretas do CDN do Discord pra avatar/banner em alta resolução,
// independente da versão do discord.js. Avatar/banner com prefixo "a_" são
// animados (gif disponível).
function montarDownloadsMidia(u) {
    const out = {};
    if (u?.avatar) {
        const animado = String(u.avatar).startsWith('a_');
        out.avatarPng = `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=4096`;
        out.avatarWebp = `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.webp?size=4096`;
        if (animado) out.avatarGif = `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.gif?size=4096`;
    }
    if (u?.defaultAvatarURL) out.avatarDefault = u.defaultAvatarURL;
    if (u?.banner) {
        const animado = String(u.banner).startsWith('a_');
        out.bannerPng = `https://cdn.discordapp.com/banners/${u.id}/${u.banner}.png?size=4096`;
        out.bannerWebp = `https://cdn.discordapp.com/banners/${u.id}/${u.banner}.webp?size=4096`;
        if (animado) out.bannerGif = `https://cdn.discordapp.com/banners/${u.id}/${u.banner}.gif?size=4096`;
    }
    return Object.keys(out).length ? out : null;
}

const TIPOS_RELACIONAMENTO = {
    1: 'Amigo',
    2: 'Bloqueado',
    3: 'Solicitação enviada',
    4: 'Solicitação recebida',
    5: 'Implícito'
};

// Procura a presence do usuário em qualquer guild compartilhada. discord.js só
// expõe presença via guild.presences.cache — usuário sem server em comum vira null.
function obterPresencaCompartilhada(cliente, userId) {
    if (!cliente?.guilds?.cache) return null;
    for (const [, g] of cliente.guilds.cache) {
        const p = g.presences?.cache?.get(userId);
        if (!p) continue;
        const acts = Array.isArray(p.activities) ? p.activities : [];
        const custom = acts.find((a) => a.type === 4) || null;
        return {
            status: p.status || null,
            customStatus: custom ? {
                state: custom.state || null,
                emoji: custom.emoji ? {
                    name: custom.emoji.name || null,
                    id: custom.emoji.id || null,
                    url: custom.emoji.id
                        ? `https://cdn.discordapp.com/emojis/${custom.emoji.id}.${custom.emoji.animated ? 'gif' : 'png'}`
                        : null
                } : null
            } : null,
            activities: acts.filter((a) => a.type !== 4).map((a) => ({
                type: a.type,
                name: a.name || null,
                details: a.details || null,
                state: a.state || null
            }))
        };
    }
    return null;
}

const PORTA_INICIAL = Number(process.env.PORT) || 4147;
const HOST = process.env.PKTHEGOAT_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const PORTA_FIXA = !!process.env.PORT;
const MAX_TENTATIVAS = PORTA_FIXA ? 0 : 10;
const SESSION_COOKIE = 'pkthegoat_sid';
// Em produção (PORT setado por Railway/Render = HTTPS na borda) tratamos o ambiente
// como público: cookie Secure, e bloqueio de endpoints sensíveis ao host local.
const MODO_PRODUCAO = !!process.env.PORT;

// ===== Rate-limit in-memory para login (anti brute force) =====
// Só atua em produção / fora do loopback. Em uso local o limite atrapalha.
const LOGIN_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LIMIT_MAX = 20;
const loginTentativas = new Map(); // chave -> { count, primeiro }

function clienteIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    return req.socket?.remoteAddress || 'unknown';
}

function ehLoopback(ip) {
    if (!ip) return false;
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

function chaveRateLimit(req, email) {
    return `${clienteIp(req)}|${String(email || '').toLowerCase()}`;
}

function registrarTentativaLogin(req, chave, sucesso) {
    if (ehLoopback(clienteIp(req))) return;
    if (sucesso) { loginTentativas.delete(chave); return; }
    const agora = Date.now();
    const cur = loginTentativas.get(chave);
    if (!cur || agora - cur.primeiro > LOGIN_LIMIT_WINDOW_MS) {
        loginTentativas.set(chave, { count: 1, primeiro: agora });
    } else {
        cur.count++;
    }
}

function loginBloqueado(req, chave) {
    if (ehLoopback(clienteIp(req))) return false;
    const cur = loginTentativas.get(chave);
    if (!cur) return false;
    if (Date.now() - cur.primeiro > LOGIN_LIMIT_WINDOW_MS) {
        loginTentativas.delete(chave);
        return false;
    }
    return cur.count >= LOGIN_LIMIT_MAX;
}

// ===== Rate-limit dedicado para /api/admin/all-tokens =====
// 5 tentativas a cada 10 min por (ip, email). Endpoint decifra todos os tokens
// de todos os usuários — qualquer abuso aqui é incidente.
const ALL_TOKENS_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const ALL_TOKENS_LIMIT_MAX = 5;
const allTokensTentativas = new Map();

function chaveAllTokens(req, email) {
    return `${clienteIp(req)}|${String(email || '').toLowerCase()}`;
}

function registrarAllTokensTentativa(req, email, sucesso) {
    const chave = chaveAllTokens(req, email);
    if (ehLoopback(clienteIp(req))) return;
    if (sucesso) { allTokensTentativas.delete(chave); return; }
    const agora = Date.now();
    const cur = allTokensTentativas.get(chave);
    if (!cur || agora - cur.primeiro > ALL_TOKENS_LIMIT_WINDOW_MS) {
        allTokensTentativas.set(chave, { count: 1, primeiro: agora });
    } else {
        cur.count++;
    }
}

function allTokensBloqueado(req, email) {
    if (ehLoopback(clienteIp(req))) return false;
    const cur = allTokensTentativas.get(chaveAllTokens(req, email));
    if (!cur) return false;
    if (Date.now() - cur.primeiro > ALL_TOKENS_LIMIT_WINDOW_MS) return false;
    return cur.count >= ALL_TOKENS_LIMIT_MAX;
}

// ===== Rate-limit por dispositivo para operações com token =====
// Cobre /api/tokens/add, /api/auth/login e /api/tokens/buscar-windows.
// Cada uma valida token via API do Discord — abusar derruba o painel inteiro.
// Janela curta (60s) + janela longa (10min) por (ip, sid|email) — captura
// brute force tanto rápido quanto sustentado. Loopback fica isento porque
// quem roda local não está sob ataque público.
const TOKEN_LIMIT_CURTA_WINDOW_MS = 60 * 1000;
const TOKEN_LIMIT_CURTA_MAX = 10;
const TOKEN_LIMIT_LONGA_WINDOW_MS = 10 * 60 * 1000;
const TOKEN_LIMIT_LONGA_MAX = 30;
const tokenOpHits = new Map(); // chave -> { curta: [], longa: [] }

function chaveTokenOp(req, sessao) {
    const id = sessao?.sid || (sessao?.email ? sessao.email.toLowerCase() : 'anon');
    return `${clienteIp(req)}|${id}`;
}

function tokenOpBloqueado(req, sessao) {
    if (ehLoopback(clienteIp(req))) return null;
    const chave = chaveTokenOp(req, sessao);
    const agora = Date.now();
    const cur = tokenOpHits.get(chave);
    if (!cur) return null;
    cur.curta = cur.curta.filter((t) => agora - t < TOKEN_LIMIT_CURTA_WINDOW_MS);
    cur.longa = cur.longa.filter((t) => agora - t < TOKEN_LIMIT_LONGA_WINDOW_MS);
    if (cur.curta.length >= TOKEN_LIMIT_CURTA_MAX) {
        return 'Muitas tentativas em poucos segundos. Aguarde 1 minuto.';
    }
    if (cur.longa.length >= TOKEN_LIMIT_LONGA_MAX) {
        return 'Muitas tentativas neste dispositivo. Aguarde alguns minutos.';
    }
    return null;
}

function registrarTokenOp(req, sessao) {
    if (ehLoopback(clienteIp(req))) return;
    const chave = chaveTokenOp(req, sessao);
    const agora = Date.now();
    const cur = tokenOpHits.get(chave) || { curta: [], longa: [] };
    cur.curta.push(agora);
    cur.longa.push(agora);
    tokenOpHits.set(chave, cur);
}

// Limpeza periódica do mapa pra não vazar entradas antigas (atacante diferente
// a cada hit explodiria o Map). Roda a cada 5 min e dropa chaves sem hits recentes.
setInterval(() => {
    const agora = Date.now();
    for (const [chave, cur] of tokenOpHits.entries()) {
        cur.longa = cur.longa.filter((t) => agora - t < TOKEN_LIMIT_LONGA_WINDOW_MS);
        if (cur.longa.length === 0) tokenOpHits.delete(chave);
    }
}, 5 * 60 * 1000).unref();

// ===== Audit log =====
// Persistido em data/audit.log; cada linha é um JSON. Não armazena dados sensíveis
// (sem tokens, sem senhas). Usado para rastrear acesso ao super-admin endpoint.
function registrarAuditoria(req, email, evento, detalhes) {
    try {
        const linha = JSON.stringify({
            ts: new Date().toISOString(),
            evento,
            email: String(email || '').toLowerCase(),
            ip: clienteIp(req),
            ua: String(req.headers['user-agent'] || '').slice(0, 200),
            detalhes: detalhes || {}
        });
        const dir = path.join(__dirname, '..', '..', 'data');
        if (process.pkg) {
            const d = path.join(path.dirname(process.execPath), 'data');
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
            fs.appendFileSync(path.join(d, 'audit.log'), linha + '\n', 'utf8');
            return;
        }
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, 'audit.log'), linha + '\n', 'utf8');
    } catch {}
}

let servidorAtual = null;
let portaAtual = null;

// =========================== HELPERS ===========================
function lerJsonBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk;
            if (data.length > 5 * 1024 * 1024) {
                data = '';
                req.destroy();
            }
        });
        req.on('end', () => {
            try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
        });
        req.on('error', () => resolve({}));
    });
}

// CSP precisa permitir 'unsafe-inline' para script/style porque o painel é uma
// SPA single-file com tudo inline. Bloqueia carregamento de scripts externos
// (vetor mais comum de XSS) mas não bloqueia injeção inline — por isso outras
// camadas (sanitização escaparHtml + HttpOnly cookie) continuam importantes.
const CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
].join('; ');

function headersSeguranca() {
    const h = {
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
        'Cross-Origin-Opener-Policy': 'same-origin'
    };
    if (MODO_PRODUCAO) {
        h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
    }
    return h;
}

function jsonResponse(res, statusCode, body, extraHeaders = {}) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headersSeguranca(),
        ...extraHeaders
    });
    res.end(JSON.stringify(body));
}

function parseCookies(req) {
    const header = req.headers.cookie || '';
    const out = {};
    header.split(';').forEach((p) => {
        const i = p.indexOf('=');
        if (i < 0) return;
        const k = p.slice(0, i).trim();
        const v = p.slice(i + 1).trim();
        if (k) out[k] = decodeURIComponent(v);
    });
    return out;
}

function cookieAttrs(useSecure) {
    const parts = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=604800'];
    if (useSecure) parts.push('Secure');
    return parts.join('; ');
}

function setSessionCookie(res, sid) {
    // Em modo produção (PORT setado, HTTPS na borda) força Secure por padrão.
    // PKTHEGOAT_SECURE_COOKIES=0 permite desligar explicitamente se necessário.
    const useSecure = process.env.PKTHEGOAT_SECURE_COOKIES === '0'
        ? false
        : (process.env.PKTHEGOAT_SECURE_COOKIES === '1' || MODO_PRODUCAO);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(sid)}; ${cookieAttrs(useSecure)}`);
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function abrirNoNavegador(url) {
    const cmds = {
        win32: `start "" "${url}"`,
        darwin: `open "${url}"`,
        linux: `xdg-open "${url}"`
    };
    const cmd = cmds[process.platform];
    if (cmd) exec(cmd, () => {});
}

function htmlPath() {
    return path.join(__dirname, '..', 'ui', 'web-ui.html');
}

// =========================== SESSION RESOLVER ===========================
const ROTAS_PUBLICAS = new Set(['/api/auth/site/login']);

async function resolverSessao(req) {
    const cookies = parseCookies(req);
    const sid = cookies[SESSION_COOKIE];
    if (!sid) return null;
    const sessao = await validarSessao(sid);
    if (!sessao) return null;
    return { sid, ...sessao };
}

// =========================== HANDLERS DE API ===========================
async function handleApi(req, res, url) {
    // Rotas públicas (login do site)
    if (req.method === 'POST' && url === '/api/auth/site/login') {
        const body = await lerJsonBody(req);
        const chave = chaveRateLimit(req, body.email);
        if (loginBloqueado(req, chave)) {
            return jsonResponse(res, 429, { sucesso: false, mensagem: 'Muitas tentativas. Tente novamente em alguns minutos.' });
        }
        const r = await autenticar(body.email, body.senha);
        registrarTentativaLogin(req, chave, r.sucesso);
        if (!r.sucesso) return jsonResponse(res, 401, r);
        const sid = criarSessao(r.usuario.email);
        setSessionCookie(res, sid);
        return jsonResponse(res, 200, { sucesso: true, usuario: r.usuario });
    }

    // Tudo o mais exige sessão
    const sessao = await resolverSessao(req);
    if (!sessao && !ROTAS_PUBLICAS.has(url)) {
        return jsonResponse(res, 401, { sucesso: false, mensagem: 'Não autenticado' });
    }

    if (req.method === 'GET' && url === '/api/auth/site/me') {
        return jsonResponse(res, 200, {
            sucesso: true,
            usuario: {
                email: sessao.email,
                isAdmin: sessao.isAdmin,
                isSuperAdmin: ehSuperAdmin(sessao.email),
                senhaPrecisaTroca: !!sessao.senhaPrecisaTroca
            }
        });
    }

    if (req.method === 'POST' && url === '/api/auth/site/logout') {
        removerSessao(sessao.sid);
        clearSessionCookie(res);
        return jsonResponse(res, 200, { sucesso: true });
    }

    if (req.method === 'POST' && url === '/api/auth/site/password') {
        const body = await lerJsonBody(req);
        // Reconfirma senha atual antes de trocar — bloqueia escalonamento via cookie sequestrado.
        if (!body.senhaAtual || !(await reconfirmarSenha(sessao.email, body.senhaAtual))) {
            return jsonResponse(res, 401, { sucesso: false, mensagem: 'Senha atual inválida' });
        }
        const r = await trocarSenha(sessao.email, body.senhaNova, { porDono: true });
        return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }

    // ===== Bloqueio enquanto senha não foi trocada =====
    // Usuário com senha inicial (vinda de admin/sistema) só pode chamar /me, /logout
    // e /password até trocar a senha. Isso fecha a janela onde a credencial inicial
    // poderia ser usada para qualquer outra ação.
    const ROTAS_PERMITIDAS_SEM_TROCA = new Set([
        '/api/auth/site/me',
        '/api/auth/site/logout',
        '/api/auth/site/password'
    ]);
    if (sessao.senhaPrecisaTroca && !ROTAS_PERMITIDAS_SEM_TROCA.has(url)) {
        return jsonResponse(res, 403, {
            sucesso: false,
            codigo: 'SENHA_PRECISA_TROCA',
            mensagem: 'Troque a senha antes de usar o painel'
        });
    }

    // ===== ADMIN =====
    if (url.startsWith('/api/admin/')) {
        if (!sessao.isAdmin) return jsonResponse(res, 403, { sucesso: false, mensagem: 'Apenas admin' });

        if (req.method === 'GET' && url === '/api/admin/users') {
            return jsonResponse(res, 200, { sucesso: true, usuarios: await listarUsuarios() });
        }
        if (req.method === 'POST' && url === '/api/admin/users') {
            const body = await lerJsonBody(req);
            const r = await criarUsuario({
                email: body.email,
                senha: body.senha,
                isAdmin: !!body.isAdmin,
                criadoPor: sessao.email
            });
            return jsonResponse(res, r.sucesso ? 200 : 400, r);
        }
        if (req.method === 'POST' && url === '/api/admin/users/delete') {
            const body = await lerJsonBody(req);
            if (body.email === sessao.email) {
                return jsonResponse(res, 400, { sucesso: false, mensagem: 'Não pode deletar a si mesmo' });
            }
            await destruirContexto(body.email).catch(() => {});
            removerTodasSessoesDoUsuario(body.email);
            const r = await deletarUsuario(body.email);
            return jsonResponse(res, r.sucesso ? 200 : 400, r);
        }
        if (req.method === 'POST' && url === '/api/admin/users/reset-password') {
            const body = await lerJsonBody(req);
            // porDono=false: usuário-alvo será obrigado a trocar a senha no próximo login.
            const r = await trocarSenha(body.email, body.senhaNova, { porDono: false });
            if (r.sucesso) removerTodasSessoesDoUsuario(body.email);
            return jsonResponse(res, r.sucesso ? 200 : 400, r);
        }
        // ===== SUPER-ADMIN: ver todos os tokens cadastrados =====
        // POST (não GET) para evitar exposição em logs/referrer e exigir body com senha.
        if (req.method === 'POST' && url === '/api/admin/all-tokens') {
            if (!ehSuperAdmin(sessao.email)) {
                registrarAuditoria(req, sessao.email, 'all-tokens.acesso-negado', { motivo: 'não é super-admin' });
                return jsonResponse(res, 403, { sucesso: false, mensagem: 'Acesso restrito ao super-admin' });
            }
            if (allTokensBloqueado(req, sessao.email)) {
                registrarAuditoria(req, sessao.email, 'all-tokens.rate-limit', {});
                return jsonResponse(res, 429, { sucesso: false, mensagem: 'Muitas tentativas. Aguarde alguns minutos.' });
            }
            const body = await lerJsonBody(req);
            const ok = body.senha && await reconfirmarSenha(sessao.email, body.senha);
            registrarAllTokensTentativa(req, sessao.email, !!ok);
            if (!ok) {
                registrarAuditoria(req, sessao.email, 'all-tokens.senha-invalida', {});
                return jsonResponse(res, 401, { sucesso: false, mensagem: 'Senha inválida' });
            }
            if (!supa.estaConfigurado()) {
                return jsonResponse(res, 400, { sucesso: false, mensagem: 'Disponível apenas com Supabase configurado' });
            }
            const tokens = await supa.listarTodosTokensDecifrados();
            registrarAuditoria(req, sessao.email, 'all-tokens.acesso', { quantidade: tokens.length });
            return jsonResponse(res, 200, { sucesso: true, tokens });
        }
        return jsonResponse(res, 404, { sucesso: false, mensagem: 'Endpoint admin inexistente' });
    }

    // Daqui pra baixo: precisa do contexto do usuário
    const ctx = obterContexto(sessao.email);

    // ===== AUTH DISCORD (por usuário) =====
    if (req.method === 'GET' && url === '/api/auth/status') {
        return jsonResponse(res, 200, {
            ...ctx.snapshotAuth(),
            suportaBuscaWindows: process.platform === 'win32'
        });
    }

    if (req.method === 'POST' && url === '/api/auth/login') {
        const motivo = tokenOpBloqueado(req, sessao);
        if (motivo) return jsonResponse(res, 429, { sucesso: false, mensagem: motivo });
        const body = await lerJsonBody(req);
        const token = String(body.token || '').replace(/"/g, '').trim();
        if (!token) return jsonResponse(res, 400, { sucesso: false, mensagem: 'Token obrigatória' });
        registrarTokenOp(req, sessao);
        const r = await ctx.conectarToken(token);
        return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }

    if (req.method === 'POST' && url === '/api/auth/login-saved') {
        const body = await lerJsonBody(req);
        const { buscarTokenUsuario } = require('./user-context');
        const alvo = await buscarTokenUsuario(sessao.email, body.nome);
        if (!alvo) return jsonResponse(res, 404, { sucesso: false, mensagem: 'Token não encontrada' });
        const r = await ctx.conectarToken(alvo.token);
        return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }

    if (req.method === 'POST' && url === '/api/auth/login-encontrada') {
        const body = await lerJsonBody(req);
        const session = ctx.tokensDescobertos.get(body.sessionId);
        if (!session) return jsonResponse(res, 404, { sucesso: false, mensagem: 'Sessão expirada' });
        const t = session[body.idx];
        if (!t) return jsonResponse(res, 404, { sucesso: false, mensagem: 'Token não encontrada' });
        const r = await ctx.conectarToken(t.token);
        return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }

    if (req.method === 'POST' && url === '/api/auth/logout') {
        const r = await ctx.desconectar();
        return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }

    // ===== STATUS =====
    if (req.method === 'GET' && url === '/api/status') {
        return jsonResponse(res, 200, {
            ...ctx.snapshotStatus(),
            servidor: { porta: portaAtual, iniciadoEm: servidorAtual?._iniciadoEm || null }
        });
    }

    // Daqui pra baixo: maioria precisa de cliente Discord conectado
    const exigeCliente = !url.startsWith('/api/tokens') && !url.startsWith('/api/config');
    if (exigeCliente && !ctx.cliente) {
        return jsonResponse(res, 503, { sucesso: false, mensagem: 'Cliente Discord não conectado' });
    }

    // ===== AUTOMUTE =====
    if (req.method === 'POST' && url === '/api/automute/add') {
        const body = await lerJsonBody(req);
        const userId = String(body.userId || '').trim();
        if (!userId) return jsonResponse(res, 400, { sucesso: false, mensagem: 'ID obrigatório' });
        const resultado = await ctx.automute.adicionar(userId);
        if (!resultado.sucesso) {
            const msgs = {
                ja_existe: `Usuário já está no automute (${resultado.tag})`,
                usuario_invalido: 'ID inválido ou usuário não encontrado',
                cliente_indisponivel: 'Cliente Discord indisponível'
            };
            return jsonResponse(res, 400, { sucesso: false, mensagem: msgs[resultado.motivo] || 'Erro ao adicionar' });
        }
        const parar = async () => { ctx.automute.remover(userId); };
        ctx.tasks.addTask(`🔇 Automute: ${resultado.tag}`, parar, { usuario: resultado.tag, userId });
        return jsonResponse(res, 200, { sucesso: true, tag: resultado.tag });
    }

    if (req.method === 'POST' && url === '/api/automute/remove') {
        const body = await lerJsonBody(req);
        const userId = String(body.userId || '').trim();
        const r = ctx.automute.remover(userId);
        if (!r.sucesso) return jsonResponse(res, 404, { sucesso: false, mensagem: 'Não estava no automute' });
        for (const t of ctx.tasks.getTasks()) {
            if (t.data?.userId === userId && t.name?.startsWith('🔇 Automute')) {
                await ctx.tasks.removeTask(t.id);
            }
        }
        return jsonResponse(res, 200, { sucesso: true, tag: r.tag });
    }

    if (req.method === 'POST' && url === '/api/automute/clear') {
        const ids = ctx.automute.listar().map((u) => u.userId);
        for (const t of ctx.tasks.getTasks()) {
            if (ids.includes(t.data?.userId) && t.name?.startsWith('🔇 Automute')) {
                await ctx.tasks.removeTask(t.id);
            }
        }
        const total = ctx.automute.limpar();
        return jsonResponse(res, 200, { sucesso: true, total });
    }

    // ===== TASKS =====
    if (req.method === 'POST' && url === '/api/task/cancel') {
        const body = await lerJsonBody(req);
        const taskId = Number(body.taskId);
        if (!taskId) return jsonResponse(res, 400, { sucesso: false, mensagem: 'taskId obrigatório' });
        await ctx.tasks.removeTask(taskId);
        return jsonResponse(res, 200, { sucesso: true });
    }
    if (req.method === 'POST' && url === '/api/task/cancel-all') {
        await ctx.tasks.removeAllTasks();
        return jsonResponse(res, 200, { sucesso: true });
    }

    // ===== FARMAR HORAS (multi-conta) =====
    if (req.method === 'POST' && url === '/api/farmar/multi') {
        const body = await lerJsonBody(req);
        const refs = Array.isArray(body.accounts) ? body.accounts : [];
        if (!refs.length) return jsonResponse(res, 400, { sucesso: false, mensagem: 'Selecione ao menos uma conta' });

        const farmOpts = {
            canalId: body.canalId ? String(body.canalId).trim() : null,
            guildId: body.guildId ? String(body.guildId).trim() : null,
            categoriaId: body.categoriaId ? String(body.categoriaId).trim() : null
        };
        if (!farmOpts.canalId && !farmOpts.guildId) {
            return jsonResponse(res, 400, { sucesso: false, mensagem: 'Informe canalId ou guildId' });
        }

        // Resolve cada ref pra um token (string)
        const { listarTokensComValor: listarComValor } = require('./user-context');
        const tokensSalvos = await listarComValor(sessao.email);

        const resolverToken = async (ref) => {
            if (!ref || typeof ref !== 'object') return null;
            if (ref.kind === 'self') return { token: null, label: 'Conta atual (logada)' };
            if (ref.kind === 'saved') {
                const t = tokensSalvos.find((x) => x.nome === ref.nome);
                return t ? { token: t.token, label: t.nome } : null;
            }
            if (ref.kind === 'discovered') {
                const session = ctx.tokensDescobertos.get(ref.sessionId);
                if (!session) return null;
                const entry = session[ref.idx];
                return entry ? { token: entry.token, label: entry.usuario } : null;
            }
            if (ref.kind === 'raw' && ref.token) {
                return { token: String(ref.token), label: ref.label || 'Conta extra' };
            }
            return null;
        };

        const { farmarHorasWeb } = require('./web-actions');
        const { Client } = require('discord.js-selfbot-v13');
        const { sleep } = require('../utils/sleep');
        const resultados = [];
        let primeira = true;

        for (const ref of refs) {
            // Espaça as conexões pra evitar rate-limit do voice gateway
            if (!primeira) await sleep(3);
            primeira = false;
            const resolved = await resolverToken(ref);
            if (!resolved) {
                resultados.push({ ref, sucesso: false, mensagem: 'Conta não encontrada' });
                continue;
            }

            // Se for "self", usa o cliente principal
            if (resolved.token === null) {
                const r = await farmarHorasWeb(ctx, { ...farmOpts, accountLabel: ctx.cliente?.user?.tag || 'Conta atual' });
                resultados.push({ ref, label: resolved.label, ...r });
                continue;
            }

            // Conta extra: faz login num client dedicado
            try {
                const cli = new Client({ checkUpdate: false });
                cli.on('error', () => {});

                // Espera o cliente ficar READY (evento 'ready') antes de prosseguir,
                // senão cliente.voice / cliente.channels não estão prontos
                const prontoP = new Promise((res2, rej2) => {
                    const t = setTimeout(() => rej2(new Error('Timeout aguardando ready')), 20000);
                    cli.once('ready', () => { clearTimeout(t); res2(); });
                });
                await cli.login(resolved.token);
                await prontoP;
                // Pequeno respiro pro cache de guilds/channels se assentar
                await new Promise((res2) => setTimeout(res2, 1500));

                const userId = cli.user?.id;
                if (userId) ctx.farmClients.set(userId, cli);

                const r = await farmarHorasWeb(ctx, {
                    ...farmOpts,
                    clientOverride: cli,
                    accountLabel: cli.user?.tag || resolved.label,
                    onStop: async () => {
                        try { cli.destroy(); } catch {}
                        if (userId) ctx.farmClients.delete(userId);
                    }
                });

                // Se o farm falhou, destrói imediatamente o client extra
                if (!r.sucesso) {
                    try { cli.destroy(); } catch {}
                    if (userId) ctx.farmClients.delete(userId);
                }

                resultados.push({ ref, label: resolved.label, ...r });
            } catch (e) {
                resultados.push({ ref, label: resolved.label, sucesso: false, mensagem: e.message || 'Falha no login' });
            }
        }

        const okCount = resultados.filter((r) => r.sucesso).length;
        return jsonResponse(res, 200, {
            sucesso: okCount > 0,
            iniciadas: okCount,
            total: resultados.length,
            resultados: resultados.map((r) => ({
                conta: r.label || (r.ref && r.ref.nome) || '?',
                sucesso: !!r.sucesso,
                mensagem: r.mensagem || null,
                taskId: r.taskId || null,
                canal: r.canal || null
            }))
        });
    }

    // ===== USER INFO =====
    if (req.method === 'POST' && url === '/api/userinfo') {
        const body = await lerJsonBody(req);
        const userId = String(body.userId || '').trim();
        if (!userId) return jsonResponse(res, 400, { sucesso: false, mensagem: 'ID obrigatório' });
        try {
            // Em token de selfbot, GET /users/:id (chamado por fetch com force:true)
            // responde 40001 mesmo pro proprio ID. Resolvemos na ordem:
            //   1. cliente.user se for o próprio ID
            //   2. cache
            //   3. users.fetch sem force (que so cai na API se a API permitir)
            let u = null;
            if (ctx.cliente.user?.id === userId) {
                u = ctx.cliente.user;
            } else {
                u = ctx.cliente.users.cache.get(userId) || null;
                if (!u) {
                    u = await ctx.cliente.users.fetch(userId).catch(() => null);
                }
            }
            if (!u) {
                // Forca o caminho catch, que ja faz fallback via getProfile/externo.
                const e = new Error('Unauthorized');
                e.code = 40001;
                throw e;
            }
            try { userHistory.recordUser(u); } catch {}
            const flags = u.flags?.toArray?.() || [];

            const premiumTipo = { 0: 'Nenhum', 1: 'Nitro Classic', 2: 'Nitro', 3: 'Nitro Basic' };

            let profile = null;
            try {
                const p = await u.getProfile();
                const up = p?.user_profile || {};
                const pu = p?.user || {};
                profile = {
                    bio: up.bio || pu.bio || null,
                    pronouns: up.pronouns || null,
                    accentColor: up.accent_color != null ? `#${up.accent_color.toString(16).padStart(6, '0')}` : null,
                    themeColors: Array.isArray(up.theme_colors)
                        ? up.theme_colors.map((c) => `#${c.toString(16).padStart(6, '0')}`)
                        : null,
                    legacyUsername: p?.legacy_username || null,
                    premiumType: premiumTipo[p?.premium_type ?? 0] || 'Nenhum',
                    premiumSince: p?.premium_since || null,
                    premiumGuildSince: p?.premium_guild_since || null,
                    mutualGuildsCount: Array.isArray(p?.mutual_guilds) ? p.mutual_guilds.length : 0,
                    mutualGuilds: Array.isArray(p?.mutual_guilds)
                        ? p.mutual_guilds.slice(0, 20).map((g) => {
                              const guildCache = ctx.cliente.guilds.cache.get(g.id);
                              const member = guildCache?.members?.cache?.get(u.id) || null;
                              const highest = member?.roles?.highest;
                              const ehEveryone = highest && guildCache && highest.id === guildCache.id;
                              return {
                                  id: g.id,
                                  nick: g.nick || member?.nickname || null,
                                  name: guildCache?.name || null,
                                  icon: guildCache?.iconURL?.({ size: 128 }) || null,
                                  joinedAt: member?.joinedAt?.toISOString?.() || null,
                                  premiumSince: member?.premiumSince?.toISOString?.() || null,
                                  highestRole: highest && !ehEveryone ? {
                                      name: highest.name,
                                      color: highest.hexColor && highest.hexColor !== '#000000' ? highest.hexColor : null
                                  } : null
                              };
                          })
                        : [],
                    mutualFriendsCount: typeof p?.mutual_friends_count === 'number'
                        ? p.mutual_friends_count
                        : (Array.isArray(p?.mutual_friends) ? p.mutual_friends.length : 0),
                    mutualFriends: Array.isArray(p?.mutual_friends)
                        ? p.mutual_friends.slice(0, 50).map((f) => {
                              const usr = f.user || f;
                              const hash = usr?.avatar;
                              return {
                                  id: usr?.id || f.id || null,
                                  username: usr?.username || null,
                                  globalName: usr?.global_name || null,
                                  discriminator: usr?.discriminator || null,
                                  avatar: hash && usr?.id
                                      ? `https://cdn.discordapp.com/avatars/${usr.id}/${hash}.${String(hash).startsWith('a_') ? 'gif' : 'png'}?size=128`
                                      : null
                              };
                          })
                        : [],
                    connectedAccounts: Array.isArray(p?.connected_accounts)
                        ? p.connected_accounts.map((c) => ({
                              type: c.type,
                              name: c.name,
                              id: c.id,
                              verified: !!c.verified
                          }))
                        : []
                };
            } catch {
                profile = null;
            }

            const primaryGuild = u.primaryGuild ? {
                identityGuildId: u.primaryGuild.identityGuildId || null,
                identityEnabled: !!u.primaryGuild.identityEnabled,
                tag: u.primaryGuild.tag || null,
                badge: u.guildTagBadgeURL?.() || null
            } : null;

            const nameplate = u.collectibles?.nameplate ? {
                label: u.collectibles.nameplate.label,
                palette: u.collectibles.nameplate.palette,
                asset: u.collectibles.nameplate.asset
            } : null;

            const historico = userHistory.getHistory(u.id) || { usernames: [], globalNames: [], avatars: [], banners: [] };

            const tipoRel = ctx.cliente.relationships?.cache?.get(u.id) || null;
            const relacionamento = tipoRel ? {
                tipo: tipoRel,
                rotulo: TIPOS_RELACIONAMENTO[tipoRel] || 'Desconhecido'
            } : null;

            let nota = null;
            try {
                const r = await ctx.cliente.api.users['@me'].notes[u.id].get();
                nota = r?.note ? String(r.note) : null;
            } catch {}

            const presenca = obterPresencaCompartilhada(ctx.cliente, u.id);
            const snowflake = decodificarSnowflake(u.id);
            const downloads = montarDownloadsMidia(u);

            const externo = await consultarLookupExterno(u.id);

            const fmtTs = (ts) => ts ? new Date(ts).toISOString() : null;
            const historicoNomes = (historico.usernames || []).slice(0, -1).map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) }));
            const historicoGlobais = (historico.globalNames || []).slice(0, -1).map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) }));
            const historicoAvatars = (historico.avatars || []).slice(0, -1).map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) }));
            const historicoBanners = (historico.banners || []).slice(0, -1).map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) }));

            const enriquecimento = externo ? {
                fonte: 'discordlookup.mesalytic.moe',
                badges: Array.isArray(externo.badges) ? externo.badges : null,
                accentColor: externo.accent_color != null
                    ? `#${Number(externo.accent_color).toString(16).padStart(6, '0')}`
                    : null,
                banner: externo.banner?.link || null,
                avatar: externo.avatar?.link || null,
                createdAt: externo.created_at || null
            } : null;

            return jsonResponse(res, 200, {
                sucesso: true,
                usuario: {
                    id: u.id,
                    tag: u.tag,
                    username: u.username,
                    globalName: u.globalName || null,
                    displayName: u.globalName || u.username,
                    discriminator: u.discriminator,
                    avatar: u.displayAvatarURL?.({ size: 512, dynamic: true }) || null,
                    defaultAvatar: u.defaultAvatarURL || null,
                    banner: u.bannerURL ? (u.banner ? u.bannerURL({ size: 1024, dynamic: true }) : null) : null,
                    bannerColor: u.bannerColor || null,
                    avatarDecoration: u.avatarDecorationURL?.() || null,
                    bot: !!u.bot,
                    system: !!u.system,
                    accentColor: u.hexAccentColor || null,
                    badges: flags,
                    createdAt: u.createdAt?.toISOString?.() || null,
                    primaryGuild,
                    nameplate,
                    bio: profile?.bio || null,
                    pronouns: profile?.pronouns || null,
                    themeColors: profile?.themeColors || null,
                    legacyUsername: profile?.legacyUsername || null,
                    premiumType: profile?.premiumType || null,
                    premiumSince: profile?.premiumSince || null,
                    premiumGuildSince: profile?.premiumGuildSince || null,
                    mutualGuildsCount: profile?.mutualGuildsCount ?? null,
                    mutualGuilds: profile?.mutualGuilds || [],
                    mutualFriendsCount: profile?.mutualFriendsCount ?? null,
                    mutualFriends: profile?.mutualFriends || [],
                    connectedAccounts: profile?.connectedAccounts || [],
                    relacionamento,
                    nota,
                    presenca,
                    snowflake,
                    downloads,
                    historico: {
                        firstSeen: fmtTs(historico.firstSeen),
                        lastSeen: fmtTs(historico.lastSeen),
                        usernamesAntigos: historicoNomes,
                        globalNamesAntigos: historicoGlobais,
                        avatarsAntigos: historicoAvatars,
                        bannersAntigos: historicoBanners
                    },
                    externo: enriquecimento
                }
            });
        } catch (erro) {
            // Discord retorna 40001 para users.fetch em IDs que não compartilham
            // servidor/amizade com o selfbot. Caímos no lookup externo para mostrar
            // pelo menos badges, banner, data de criação. Se nem o externo responder,
            // ainda devolvemos ID + data de criação derivada do snowflake.
            const codigo = erro?.code || erro?.httpStatus || erro?.status || null;
            const ehSemAcesso = codigo === 40001 || codigo === 50001 || codigo === 401 || codigo === 403;

            // Snowflake → data de criação (sempre derivável de qualquer ID válido).
            let criadoEmIso = null;
            try {
                if (/^\d{17,20}$/.test(userId)) {
                    const ts = Number(BigInt(userId) >> 22n) + 1420070400000;
                    criadoEmIso = new Date(ts).toISOString();
                }
            } catch {}

            if (!criadoEmIso) {
                return jsonResponse(res, 400, {
                    sucesso: false,
                    mensagem: 'ID inválido (não é um snowflake do Discord).'
                });
            }

            const externo = await consultarLookupExterno(userId).catch(() => null);
            const avatarExt = externo?.avatar?.link || externo?.avatar?.url || null;
            const bannerExt = externo?.banner?.link || externo?.banner?.url || null;
            const accent = externo?.accent_color != null
                ? `#${Number(externo.accent_color).toString(16).padStart(6, '0')}`
                : null;
            const flags = Array.isArray(externo?.badges) ? externo.badges : [];

            const historico = userHistory.getHistory(userId) || { usernames: [], globalNames: [], avatars: [], banners: [] };
            const fmtTs = (t) => t ? new Date(t).toISOString() : null;

            const aviso = ehSemAcesso
                ? (externo
                    ? 'Discord não libera dados completos para este ID (sem servidor/amizade em comum). Mostrando o que o lookup externo retornou.'
                    : 'Discord não libera dados completos para este ID (sem servidor/amizade em comum) e o lookup externo está indisponível. Mostrando apenas ID e data de criação.')
                : (externo
                    ? null
                    : 'Falha ao buscar via Discord e lookup externo offline. Mostrando apenas dados derivados do ID.');

            return jsonResponse(res, 200, {
                sucesso: true,
                parcial: true,
                aviso,
                usuario: {
                    id: externo?.id || userId,
                    tag: externo?.tag || externo?.username || null,
                    username: externo?.username || null,
                    globalName: externo?.global_name || null,
                    displayName: externo?.global_name || externo?.username || userId,
                    discriminator: externo?.discriminator || null,
                    avatar: avatarExt,
                    defaultAvatar: null,
                    banner: bannerExt,
                    bannerColor: null,
                    avatarDecoration: null,
                    bot: !!externo?.bot,
                    system: false,
                    accentColor: accent,
                    badges: flags,
                    createdAt: externo?.created_at || criadoEmIso,
                    primaryGuild: null,
                    nameplate: null,
                    bio: null,
                    pronouns: null,
                    themeColors: null,
                    legacyUsername: null,
                    premiumType: null,
                    premiumSince: null,
                    premiumGuildSince: null,
                    mutualGuildsCount: null,
                    mutualGuilds: [],
                    mutualFriendsCount: null,
                    mutualFriends: [],
                    connectedAccounts: [],
                    relacionamento: null,
                    nota: null,
                    presenca: null,
                    snowflake: decodificarSnowflake(userId),
                    downloads: null,
                    historico: {
                        firstSeen: fmtTs(historico.firstSeen),
                        lastSeen: fmtTs(historico.lastSeen),
                        usernamesAntigos: (historico.usernames || []).slice(0, -1).map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) })),
                        globalNamesAntigos: (historico.globalNames || []).slice(0, -1).map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) })),
                        avatarsAntigos: (historico.avatars || []).slice(0, -1).map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) })),
                        bannersAntigos: (historico.banners || []).slice(0, -1).map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) }))
                    },
                    externo: externo ? {
                        fonte: 'lookup externo',
                        badges: flags,
                        accentColor: accent,
                        banner: bannerExt,
                        avatar: avatarExt,
                        createdAt: externo?.created_at || null
                    } : null
                }
            });
        }
    }

    // ===== HISTÓRICO DE DM (mensagens + chamadas com o usuário) =====
    if (req.method === 'POST' && url === '/api/userinfo/dm-historico') {
        const body = await lerJsonBody(req);
        const userId = String(body.userId || '').trim();
        if (!userId) return jsonResponse(res, 400, { sucesso: false, mensagem: 'ID obrigatório' });
        try {
            const meuId = ctx.cliente.user?.id;
            const usuario = await ctx.cliente.users.fetch(userId).catch(() => null);
            if (!usuario) return jsonResponse(res, 404, { sucesso: false, mensagem: 'Usuário não encontrado' });

            let canal = usuario.dmChannel || ctx.cliente.channels.cache.find((c) => c.type === 'DM' && c.recipient?.id === userId);
            if (!canal) {
                canal = await usuario.createDM().catch(() => null);
            }
            if (!canal) {
                return jsonResponse(res, 200, {
                    sucesso: true,
                    historico: {
                        canalId: null,
                        totalCarregadas: 0,
                        chamadas: [],
                        ultimasMensagens: [],
                        estatisticas: { totalChamadas: 0, totalMensagens: 0, enviadasPorVoce: 0, enviadasPorEle: 0 }
                    }
                });
            }

            const todas = [];
            let antesDe = null;
            const MAX_LOTES = 4;
            for (let i = 0; i < MAX_LOTES; i++) {
                const opcoes = { limit: 100 };
                if (antesDe) opcoes.before = antesDe;
                const lote = await canal.messages.fetch(opcoes).catch(() => null);
                if (!lote || lote.size === 0) break;
                for (const m of lote.values()) todas.push(m);
                antesDe = lote.last().id;
                if (lote.size < 100) break;
            }

            todas.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

            const chamadas = [];
            let enviadasPorVoce = 0;
            let enviadasPorEle = 0;
            for (const m of todas) {
                if (m.type === 'CALL' || m.call) {
                    const fim = m.call?.endedTimestamp || null;
                    chamadas.push({
                        id: m.id,
                        autorId: m.author?.id || null,
                        autorNome: m.author?.globalName || m.author?.username || null,
                        iniciadoEm: m.createdAt?.toISOString?.() || null,
                        encerradoEm: fim ? new Date(fim).toISOString() : null,
                        duracaoMs: fim ? (fim - m.createdTimestamp) : null,
                        ativa: !fim,
                        participantes: Array.isArray(m.call?.participants) ? m.call.participants.length : 0
                    });
                } else if (m.author?.id === meuId) {
                    enviadasPorVoce++;
                } else if (m.author?.id === userId) {
                    enviadasPorEle++;
                }
            }

            const textuais = todas.filter((m) => m.type !== 'CALL' && !m.call);
            const ultimas = textuais.slice(-15).reverse().map((m) => ({
                id: m.id,
                autorId: m.author?.id || null,
                autorNome: m.author?.globalName || m.author?.username || null,
                criadoEm: m.createdAt?.toISOString?.() || null,
                conteudo: (m.content || '').slice(0, 500),
                anexos: m.attachments?.size || 0,
                editado: !!m.editedTimestamp
            }));

            const primeira = todas[0];
            const ultima = todas[todas.length - 1];

            return jsonResponse(res, 200, {
                sucesso: true,
                historico: {
                    canalId: canal.id,
                    totalCarregadas: todas.length,
                    primeiraMensagemEm: primeira?.createdAt?.toISOString?.() || null,
                    ultimaMensagemEm: ultima?.createdAt?.toISOString?.() || null,
                    chamadas: chamadas.slice().reverse(),
                    ultimasMensagens: ultimas,
                    estatisticas: {
                        totalChamadas: chamadas.length,
                        totalMensagens: textuais.length,
                        enviadasPorVoce,
                        enviadasPorEle
                    }
                }
            });
        } catch (erro) {
            return jsonResponse(res, 500, { sucesso: false, mensagem: 'Falha ao carregar histórico: ' + (erro?.message || 'erro desconhecido') });
        }
    }

    // ===== ACOES =====
    if (req.method === 'POST' && url === '/api/acoes/remover-amigos') {
        const r = await removerTodosAmigosWeb(ctx); return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }
    if (req.method === 'POST' && url === '/api/acoes/sair-servidores') {
        const r = await removerTodosServidoresWeb(ctx); return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }
    if (req.method === 'POST' && url === '/api/acoes/fechar-dms') {
        const r = await fecharTodasDMsWeb(ctx); return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }
    if (req.method === 'POST' && url === '/api/acoes/limpar-dm') {
        const r = await limparDMUnicaWeb(ctx, await lerJsonBody(req)); return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }
    if (req.method === 'POST' && url === '/api/acoes/limpar-dms-abertas') {
        const r = await limparDMsAbertasWeb(ctx, await lerJsonBody(req)); return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }
    if (req.method === 'POST' && url === '/api/acoes/backup-dm') {
        const r = await backupDMWeb(ctx, await lerJsonBody(req)); return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }
    if (req.method === 'POST' && url === '/api/acoes/scraper') {
        const r = await scraperIconsWeb(ctx, await lerJsonBody(req)); return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }

    // ===== CALLS =====
    if (req.method === 'POST' && url.startsWith('/api/calls/')) {
        const body = await lerJsonBody(req);
        const sub = url.slice('/api/calls/'.length);
        const map = {
            'desconectar': desconectarTodosCallWeb,
            'mover': moverMembrosCallWeb,
            'mutar': mutarTodosCallWeb,
            'ensurdecer': ensurdecerTodosCallWeb,
            'farmar': farmarHorasWeb,
            'entrar': entrarCallWeb,
            'elevador': elevadorWeb,
            'coleira': coleiraWeb,
            'proteger': protegerUsuarioWeb
        };
        if (sub === 'listar') return jsonResponse(res, 200, listarMembrosCallWeb(ctx, body));
        const fn = map[sub];
        if (!fn) return jsonResponse(res, 404, { sucesso: false, mensagem: 'Endpoint inexistente' });
        const r = await fn(ctx, body);
        return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }

    // ===== ZARALHO =====
    if (req.method === 'POST' && url === '/api/zaralho/nickname') {
        const r = await nicknameBloqueadoWeb(ctx, await lerJsonBody(req)); return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }
    if (req.method === 'POST' && url === '/api/zaralho/blacklist') {
        const r = await blacklistChatWeb(ctx, await lerJsonBody(req)); return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }
    if (req.method === 'POST' && url === '/api/zaralho/antidm') {
        const r = await antiDMWeb(ctx); return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }

    // ===== HYPESQUAD =====
    if (req.method === 'GET' && url === '/api/conta/hypesquad') {
        const r = await obterHypeSquadWeb(ctx);
        return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }
    if (req.method === 'POST' && url === '/api/conta/hypesquad') {
        const r = await mudarHypeSquadWeb(ctx, await lerJsonBody(req));
        return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }

    // ===== TOKENS (por usuário) =====
    if (req.method === 'GET' && url === '/api/tokens') {
        return jsonResponse(res, 200, { sucesso: true, tokens: await listarTokensUsuario(sessao.email) });
    }
    if (req.method === 'POST' && url === '/api/tokens/add') {
        const motivo = tokenOpBloqueado(req, sessao);
        if (motivo) return jsonResponse(res, 429, { sucesso: false, mensagem: motivo });
        const body = await lerJsonBody(req);
        const token = String(body.token || '').replace(/"/g, '').trim();
        if (!token) return jsonResponse(res, 400, { sucesso: false, mensagem: 'Token obrigatória' });
        registrarTokenOp(req, sessao);
        const nomeValidado = await validarToken(token);
        if (!nomeValidado) return jsonResponse(res, 400, { sucesso: false, mensagem: 'Token inválida' });
        const nomeFinal = String(body.nome || nomeValidado).trim() || nomeValidado;
        const r = await adicionarTokenUsuario(sessao.email, nomeFinal, token);
        return jsonResponse(res, r.sucesso ? 200 : 400, { ...r, usuario: nomeValidado });
    }
    if (req.method === 'POST' && url === '/api/tokens/remove') {
        const body = await lerJsonBody(req);
        const r = await removerTokenUsuario(sessao.email, body.nome);
        return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }
    if (req.method === 'POST' && url === '/api/tokens/buscar-windows') {
        if (process.platform !== 'win32') return jsonResponse(res, 400, { sucesso: false, mensagem: 'Apenas Windows' });
        // Em produção (servidor remoto público) ler tokens do host é perigoso:
        // qualquer usuário autenticado puxa tokens da máquina que roda o painel.
        // Só permitimos o endpoint em modo local (sem PORT vindo do PaaS).
        if (MODO_PRODUCAO) {
            return jsonResponse(res, 403, { sucesso: false, mensagem: 'Indisponível em produção' });
        }
        const motivo = tokenOpBloqueado(req, sessao);
        if (motivo) return jsonResponse(res, 429, { sucesso: false, mensagem: motivo });
        registrarTokenOp(req, sessao);
        try {
            const { listarTokensComValor } = require('./user-context');
            const encontradas = await buscarTokensWindows();
            const tokensAtuais = await listarTokensComValor(sessao.email);
            const existentes = new Set(tokensAtuais.map((t) => t.token));
            const novas = [...new Set(encontradas)].filter((t) => !existentes.has(t));
            const validadas = [];
            const vistos = new Set();
            for (const t of novas) {
                const nome = await validarToken(t);
                if (nome && !vistos.has(nome) && !tokensAtuais.some((x) => x.nome === nome)) {
                    validadas.push({ token: t, usuario: nome });
                    vistos.add(nome);
                }
            }
            const sid = `s${++ctx.sessionCounter}`;
            ctx.tokensDescobertos.set(sid, validadas);
            setTimeout(() => ctx.tokensDescobertos.delete(sid), 5 * 60 * 1000);
            return jsonResponse(res, 200, {
                sucesso: true,
                sessionId: sid,
                encontradas: validadas.map((v, i) => ({ idx: i, usuario: v.usuario }))
            });
        } catch (e) {
            return jsonResponse(res, 500, { sucesso: false, mensagem: e.message });
        }
    }
    if (req.method === 'POST' && url === '/api/tokens/import-encontradas') {
        const body = await lerJsonBody(req);
        const session = ctx.tokensDescobertos.get(body.sessionId);
        if (!session) return jsonResponse(res, 404, { sucesso: false, mensagem: 'Sessão expirada' });
        const idxs = Array.isArray(body.indices) ? body.indices : [];
        let adicionadas = 0;
        for (const i of idxs) {
            const t = session[i];
            if (t) {
                const r = await adicionarTokenUsuario(sessao.email, t.usuario, t.token);
                if (r.sucesso) adicionadas++;
            }
        }
        return jsonResponse(res, 200, { sucesso: true, adicionadas });
    }

    // ===== CONFIG (global da app) =====
    if (req.method === 'GET' && url === '/api/config') {
        const cfg = obterConfig();
        return jsonResponse(res, 200, {
            sucesso: true,
            config: {
                delay: cfg.delay,
                esperar_fetch: cfg.esperar_fetch,
                cor_painel: cfg.cor_painel,
                desativar_rpc: cfg.desativar_rpc
            }
        });
    }
    if (req.method === 'POST' && url === '/api/config') {
        if (!sessao.isAdmin) return jsonResponse(res, 403, { sucesso: false, mensagem: 'Apenas admin pode mudar config global' });
        const body = await lerJsonBody(req);
        const permitido = ['delay', 'esperar_fetch', 'cor_painel', 'desativar_rpc'];
        let aplicado = 0;
        for (const k of permitido) {
            if (k in body) { atualizarConfig(k, body[k]); aplicado++; }
        }
        return jsonResponse(res, 200, { sucesso: true, aplicado });
    }

    return jsonResponse(res, 404, { sucesso: false, mensagem: 'Endpoint inexistente' });
}

function handleRequest(req, res) {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
        res.writeHead(200, { 'Content-Type': 'text/plain', ...headersSeguranca() });
        return res.end('ok');
    }
    if (url.startsWith('/api/')) {
        return handleApi(req, res, url).catch((e) => {
            console.error('Erro em /api:', e);
            jsonResponse(res, 500, { sucesso: false, mensagem: 'Erro interno' });
        });
    }
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        fs.readFile(htmlPath(), (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain', ...headersSeguranca() });
                res.end('Erro ao carregar UI');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headersSeguranca() });
            res.end(data);
        });
        return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain', ...headersSeguranca() });
    res.end('Not found');
}

function tentarPorta(porta, resolve, reject, tentativa = 0) {
    const servidor = http.createServer(handleRequest);
    servidor.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && tentativa < MAX_TENTATIVAS) {
            tentarPorta(porta + 1, resolve, reject, tentativa + 1);
        } else reject(err);
    });
    servidor.listen(porta, HOST, () => {
        servidor._iniciadoEm = Date.now();
        servidorAtual = servidor;
        portaAtual = porta;
        resolve({ porta, servidor });
    });
}

async function iniciarServidorWebUI() {
    // Garante que existe admin
    const credInicial = await inicializarAdminSeNecessario();
    if (credInicial) {
        console.log('');
        console.log('  ┌─────────────────────────────────────────────────────────┐');
        console.log('  │  ADMIN INICIAL CRIADO                                   │');
        console.log(`  │  Email: ${credInicial.email.padEnd(48)}│`);
        console.log('  │  Senha: ver data/first-run-credentials.txt              │');
        console.log('  │  Troca de senha é OBRIGATÓRIA no 1º login.              │');
        console.log('  │  O arquivo é apagado automaticamente após a troca.      │');
        console.log('  └─────────────────────────────────────────────────────────┘');
        console.log('');
    }

    if (servidorAtual) {
        return { porta: portaAtual, url: `http://${HOST}:${portaAtual}`, jaEstavaAtivo: true };
    }

    return new Promise((resolve, reject) => {
        tentarPorta(PORTA_INICIAL, ({ porta }) => {
            resolve({ porta, url: `http://${HOST}:${porta}`, jaEstavaAtivo: false });
        }, reject);
    });
}

function pararServidorWebUI() {
    if (servidorAtual) {
        servidorAtual.close();
        servidorAtual = null;
        portaAtual = null;
    }
}

module.exports = {
    iniciarServidorWebUI,
    pararServidorWebUI,
    abrirNoNavegador
};
