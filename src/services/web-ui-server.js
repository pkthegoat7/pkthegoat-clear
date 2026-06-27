const http = require('http');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { exec } = require('child_process');

const {
    inicializarAdminSeNecessario,
    criarUsuario,
    trocarSenha,
    deletarUsuario,
    listarUsuarios,
    autenticar,
    loginOuCriarViaDiscord,
    reconfirmarSenha,
    criarSessao,
    validarSessao,
    removerSessao,
    removerTodasSessoesDoUsuario,
    buscarUsuario,
    criarDesafio2fa,
    obterDesafio2fa,
    registrarTentativaDesafio,
    consumirDesafio2fa,
    decifrarSegredoTotp,
    verificarCodigoBackup,
    cifrarSegredoTotp,
    gerarCodigosBackup
} = require('./auth');
const totp = require('./totp');
const {
    obterContexto,
    destruirContexto,
    adicionarTokenUsuario,
    removerTokenUsuario,
    listarTokensUsuario
} = require('./user-context');
const supa = require('./supabase');
const discordOauth = require('./discord-oauth');

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
    clonarCanalWeb,
    isValidFileType,
    desconectarTodosCallWeb,
    moverMembrosCallWeb,
    mutarTodosCallWeb,
    ensurdecerTodosCallWeb,
    listarMembrosCallWeb,
    listarMinhaCallWeb,
    protegerMeuWeb,
    farmarHorasWeb,
    entrarCallWeb,
    elevadorWeb,
    coleiraWeb,
    protegerUsuarioWeb,
    nicknameBloqueadoWeb,
    blacklistChatWeb,
    antiDMWeb,
    autoReagirWeb,
    listarEmojisCustomWeb,
    obterHypeSquadWeb,
    mudarHypeSquadWeb
} = require('./web-actions');
const yazl = require('yazl');
const { obterConfig, atualizarConfig } = require('../config/configuracao');
const { validarToken, buscarTokensWindows } = require('./tokens');
const userHistory = require('./user-history');
const voiceHistory = require('./voice-history');

// Tracker próprio (Railway): histórico de nomes/avatares, presença, voz e atividades
// gravados pelo self-bot rodando no servidor. Complementa o lookup externo.
const TRACKER_API_URL = (process.env.TRACKER_API_URL || 'https://tracker-production-2b17.up.railway.app').replace(/\/+$/, '');
const TRACKER_API_KEY = process.env.TRACKER_API_KEY || '';

async function consultarTrackerAPI(userId) {
    if (!TRACKER_API_KEY) return null;
    const headers = { 'X-API-Key': TRACKER_API_KEY, 'Accept': 'application/json' };
    const get = async (path) => {
        try {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 4000);
            const r = await fetch(`${TRACKER_API_URL}${path}`, { headers, signal: ctrl.signal });
            clearTimeout(to);
            if (!r.ok) return null;
            return await r.json();
        } catch { return null; }
    };
    try {
        const enc = encodeURIComponent(userId);
        const [user, names, avatars, presence, voice, activities, onlineTime, voiceStats, games, mutualGuilds] = await Promise.all([
            get(`/users/${enc}`),
            get(`/users/${enc}/names`),
            get(`/users/${enc}/avatars`),
            get(`/users/${enc}/presence?limit=50`),
            get(`/users/${enc}/voice?limit=50`),
            get(`/users/${enc}/activities?limit=50`),
            get(`/users/${enc}/online-time?days=14`),
            get(`/users/${enc}/voice/stats`),
            get(`/users/${enc}/games?limit=10`),
            get(`/users/${enc}/mutual-guilds`)
        ]);
        if (!user) return null;
        return {
            fonte: 'tracker (railway)',
            usuario: user,
            historicoNomes: Array.isArray(names) ? names : [],
            historicoAvatars: Array.isArray(avatars) ? avatars : [],
            presencaRecente: Array.isArray(presence) ? presence : [],
            vozRecente: Array.isArray(voice) ? voice : [],
            atividadesRecentes: Array.isArray(activities) ? activities : [],
            tempoOnline: onlineTime || null,
            statsVoz: voiceStats || null,
            jogos: Array.isArray(games?.games) ? games.games : [],
            servidoresComuns: Array.isArray(mutualGuilds?.guilds) ? mutualGuilds.guilds : []
        };
    } catch {
        return null;
    }
}

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

// Garante que uma promise (tipicamente chamada à API do Discord, que pode ficar
// presa na fila de rate-limit) nunca pendure o handler: se passar de `ms`,
// resolve com `fallback`. Sem isso, um getProfile/fetch rate-limitado deixava a
// aba "Buscar usuário" carregando pra sempre (só voltava com F5).
function comTimeout(promise, ms, fallback = null) {
    let timer;
    const limite = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
    return Promise.race([
        Promise.resolve(promise).catch(() => fallback),
        limite
    ]).finally(() => clearTimeout(timer));
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

// Lanyard expõe presence (status, custom status, Spotify, atividades) de qualquer
// usuário que esteja no Discord do Lanyard (discord.gg/lanyard). Funciona como
// fonte adicional — vem null se o user não está lá.
async function consultarLanyard(userId) {
    try {
        const r = await consultarLookupHTTPS('api.lanyard.rest', `/v1/users/${encodeURIComponent(userId)}`);
        if (!r || r.success === false || !r.data) return null;
        const d = r.data;
        const acts = Array.isArray(d.activities) ? d.activities : [];
        const custom = acts.find((a) => a.type === 4) || null;
        return {
            fonte: 'lanyard.rest',
            status: d.discord_status || null,
            activeOnDesktop: !!d.active_on_discord_desktop,
            activeOnMobile: !!d.active_on_discord_mobile,
            activeOnWeb: !!d.active_on_discord_web,
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
            spotify: d.listening_to_spotify && d.spotify ? {
                song: d.spotify.song || null,
                artist: d.spotify.artist || null,
                album: d.spotify.album || null,
                albumArt: d.spotify.album_art_url || null,
                trackId: d.spotify.track_id || null,
                startedAt: d.spotify.timestamps?.start ? new Date(d.spotify.timestamps.start).toISOString() : null,
                endsAt: d.spotify.timestamps?.end ? new Date(d.spotify.timestamps.end).toISOString() : null
            } : null,
            atividades: acts.filter((a) => a.type !== 4).map((a) => ({
                type: a.type,
                name: a.name || null,
                details: a.details || null,
                state: a.state || null,
                applicationId: a.application_id || null,
                largeImage: a.assets?.large_image
                    ? (String(a.assets.large_image).startsWith('mp:external/')
                        ? `https://media.discordapp.net/external/${a.assets.large_image.slice('mp:external/'.length)}`
                        : (a.application_id
                            ? `https://cdn.discordapp.com/app-assets/${a.application_id}/${a.assets.large_image}.png`
                            : null))
                    : null,
                largeText: a.assets?.large_text || null,
                startedAt: a.timestamps?.start ? new Date(a.timestamps.start).toISOString() : null
            }))
        };
    } catch {
        return null;
    }
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
const OAUTH_STATE_COOKIE = 'pkthegoat_oauth_state';
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
// (sem tokens, sem senhas). Rastreia acesso ao super-admin endpoint e tentativas
// de login do site (sucesso/falha/bloqueio) com IP + User-Agent.
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

// Lê as últimas `limite` entradas do audit.log, mais recentes primeiro.
// Mesmo caminho do registrarAuditoria (pkg vs source). Arquivo ausente [].
function lerAuditoria(limite = 500) {
    try {
        const base = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..', '..');
        const arquivo = path.join(base, 'data', 'audit.log');
        if (!fs.existsSync(arquivo)) return [];
        const linhas = fs.readFileSync(arquivo, 'utf8').split('\n').filter(Boolean);
        const entradas = [];
        for (const l of linhas.slice(-limite)) {
            try { entradas.push(JSON.parse(l)); } catch {}
        }
        return entradas.reverse();
    } catch {
        return [];
    }
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

// Em modo produção (PORT setado, HTTPS na borda) força Secure por padrão.
// PKTHEGOAT_SECURE_COOKIES=0 permite desligar explicitamente se necessário.
function usarCookieSecure() {
    return process.env.PKTHEGOAT_SECURE_COOKIES === '0'
        ? false
        : (process.env.PKTHEGOAT_SECURE_COOKIES === '1' || MODO_PRODUCAO);
}

function setSessionCookie(res, sid) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(sid)}; ${cookieAttrs(usarCookieSecure())}`);
}

// Base pública do painel, usada para montar o redirect_uri do Discord.
// Em produção, defina PKTHEGOAT_BASE_URL (ex.: https://seuapp.up.railway.app).
function baseUrlPublica(req) {
    if (process.env.PKTHEGOAT_BASE_URL) return process.env.PKTHEGOAT_BASE_URL.replace(/\/+$/, '');
    const proto = MODO_PRODUCAO ? 'https' : 'http';
    return `${proto}://${req.headers.host}`;
}

function discordRedirectUri(req) {
    return process.env.DISCORD_REDIRECT_URI || `${baseUrlPublica(req)}/api/auth/discord/callback`;
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

// Envia um buffer com gzip quando o navegador aceita (Accept-Encoding: gzip).
// A UI principal tem ~317KB; comprimida cai pra ~70KB, cortando bastante o
// tempo de load — principalmente quando o app roda num host remoto.
function enviarComprimido(req, res, statusCode, mime, data, extraHeaders = {}) {
    const baseHeaders = { 'Content-Type': mime, ...headersSeguranca(), ...extraHeaders };
    const aceitaGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (!aceitaGzip) {
        res.writeHead(statusCode, baseHeaders);
        res.end(data);
        return;
    }
    zlib.gzip(data, (err, comprimido) => {
        if (err) {
            res.writeHead(statusCode, baseHeaders);
            res.end(data);
            return;
        }
        res.writeHead(statusCode, { ...baseHeaders, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
        res.end(comprimido);
    });
}

// =========================== SESSION RESOLVER ===========================
const ROTAS_PUBLICAS = new Set(['/api/auth/site/login', '/api/auth/site/2fa']);

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
        // E-mail tentado, limitado p/ não inflar o log com lixo (nunca grava a senha).
        const emailTentado = String(body.email || '').slice(0, 120);
        // Login por e-mail/senha é exclusivo do super-admin. Todas as demais
        // contas entram apenas via Discord (OAuth2).
        if (!ehSuperAdmin(body.email)) {
            registrarAuditoria(req, emailTentado, 'login.bloqueado', { motivo: 'somente-oauth2' });
            return jsonResponse(res, 403, { sucesso: false, mensagem: 'Login por e-mail é exclusivo do administrador. Use "Entrar com Discord".' });
        }
        const chave = chaveRateLimit(req, body.email);
        if (loginBloqueado(req, chave)) {
            registrarAuditoria(req, emailTentado, 'login.bloqueado', {});
            return jsonResponse(res, 429, { sucesso: false, mensagem: 'Muitas tentativas. Tente novamente em alguns minutos.' });
        }
        const r = await autenticar(body.email, body.senha);
        registrarTentativaLogin(req, chave, r.sucesso);
        registrarAuditoria(req, emailTentado, r.sucesso ? 'login.sucesso' : 'login.falha', {});
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
    }

    if (req.method === 'POST' && url === '/api/auth/site/2fa') {
        const body = await lerJsonBody(req);
        const idDesafio = String(body.desafio || '');
        const desafio = obterDesafio2fa(idDesafio);
        if (!desafio) {
            return jsonResponse(res, 401, { sucesso: false, mensagem: 'Desafio inválido ou expirado. Faça login novamente.' });
        }
        // Rate-limit por IP, igual ao login. O cap de tentativas por desafio
        // (DESAFIO_MAX_TENT) é o backstop principal contra brute-force dos 6 dígitos.
        const chave = chaveRateLimit(req, desafio.email);
        if (loginBloqueado(req, chave)) {
            registrarAuditoria(req, desafio.email, 'login.bloqueado', { fase: '2fa' });
            return jsonResponse(res, 429, { sucesso: false, mensagem: 'Muitas tentativas. Tente novamente em alguns minutos.' });
        }
        const codigo = String(body.codigo || '').trim();
        const usuario = await buscarUsuario(desafio.email);
        if (!usuario || !usuario.totpAtivado || !usuario.totpSecretCifrado) {
            consumirDesafio2fa(idDesafio);
            return jsonResponse(res, 401, { sucesso: false, mensagem: 'Configuração de 2FA inválida.' });
        }
        let ok = false;
        let viaBackup = false;
        let stepUsado = null;
        try {
            stepUsado = totp.verificarComStep(decifrarSegredoTotp(usuario.totpSecretCifrado), codigo);
        } catch { stepUsado = null; }
        // Rejeita replay: código TOTP só vale se o passo for posterior ao último já usado.
        if (stepUsado !== null && stepUsado > (usuario.totpLastStep || 0)) {
            ok = true;
        }
        // Só tenta backup se não for um código TOTP (6 dígitos nunca casa com backup de 10 hex).
        if (!ok && !/^\d{6}$/.test(codigo)) {
            const rb = verificarCodigoBackup(codigo, usuario.backupCodes);
            if (rb.ok) {
                ok = true;
                viaBackup = true;
                await supa.atualizarTotp(desafio.email, { totpBackupCodes: rb.hashesRestantes });
            }
        }
        registrarTentativaLogin(req, chave, ok);
        registrarTentativaDesafio(idDesafio);
        if (!ok) {
            registrarAuditoria(req, desafio.email, '2fa.login.falha', { fase: '2fa' });
            return jsonResponse(res, 401, { sucesso: false, mensagem: 'Código inválido' });
        }
        if (!viaBackup && stepUsado !== null) {
            await supa.atualizarTotp(desafio.email, { totpLastStep: stepUsado });
        }
        consumirDesafio2fa(idDesafio);
        registrarAuditoria(req, desafio.email, viaBackup ? '2fa.backup.usado' : '2fa.login.sucesso', {});
        const sid = criarSessao(desafio.email);
        setSessionCookie(res, sid);
        return jsonResponse(res, 200, { sucesso: true, usuario: { email: usuario.email, isAdmin: !!usuario.isAdmin } });
    }

    // ===== Login via Discord (OAuth2) =====
    // 1ª etapa: manda o usuário para o Discord autorizar.
    if (req.method === 'GET' && url === '/api/auth/discord') {
        if (!discordOauth.estaConfigurado()) {
            res.writeHead(302, { Location: '/login?erro=discord_off', ...headersSeguranca() });
            return res.end();
        }
        const state = require('crypto').randomBytes(16).toString('hex');
        const secure = usarCookieSecure() ? '; Secure' : '';
        res.writeHead(302, {
            Location: discordOauth.urlAutorizacao(discordRedirectUri(req), state),
            'Set-Cookie': `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
            ...headersSeguranca()
        });
        return res.end();
    }

    // 2ª etapa: o Discord redireciona de volta para cá com ?code=...&state=...
    if (req.method === 'GET' && url === '/api/auth/discord/callback') {
        const limparState = `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
        const redirecionarErro = () => {
            res.writeHead(302, { Location: '/login?erro=discord', 'Set-Cookie': limparState, ...headersSeguranca() });
            res.end();
        };
        const params = new URL(req.url, 'http://local').searchParams;
        const code = params.get('code');
        const state = params.get('state');
        const stateCookie = parseCookies(req)[OAUTH_STATE_COOKIE];
        // Anti-CSRF: o state da URL precisa bater com o que guardamos no cookie.
        if (!code || !state || !stateCookie || state !== stateCookie) {
            registrarAuditoria(req, '', 'login.discord.falha', { motivo: 'state' });
            return redirecionarErro();
        }
        const token = await discordOauth.trocarCodigo(code, discordRedirectUri(req));
        const perfil = token ? await discordOauth.buscarUsuario(token) : null;
        if (!perfil) {
            registrarAuditoria(req, '', 'login.discord.falha', { motivo: 'token' });
            return redirecionarErro();
        }
        const r = await loginOuCriarViaDiscord(perfil);
        if (!r.sucesso) {
            registrarAuditoria(req, perfil.email || '', 'login.discord.falha', { motivo: r.mensagem });
            return redirecionarErro();
        }
        const sid = criarSessao(r.email);
        registrarAuditoria(req, r.email, 'login.discord.sucesso', { discordId: perfil.id });
        const cookieSessao = `${SESSION_COOKIE}=${encodeURIComponent(sid)}; ${cookieAttrs(usarCookieSecure())}`;
        res.writeHead(302, { Location: '/', 'Set-Cookie': [cookieSessao, limparState], ...headersSeguranca() });
        return res.end();
    }

    // Tudo o mais exige sessão
    const sessao = await resolverSessao(req);
    if (!sessao && !ROTAS_PUBLICAS.has(url)) {
        return jsonResponse(res, 401, { sucesso: false, mensagem: 'Não autenticado' });
    }

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

    if (req.method === 'POST' && url === '/api/auth/site/2fa/ativar') {
        const body = await lerJsonBody(req);
        const u = await buscarUsuario(sessao.email);
        if (!u || !u.totpSecretCifrado) {
            return jsonResponse(res, 400, { sucesso: false, mensagem: 'Inicie o setup primeiro.' });
        }
        let stepAtivacao = null;
        try { stepAtivacao = totp.verificarComStep(decifrarSegredoTotp(u.totpSecretCifrado), String(body.codigo || '').trim()); }
        catch { stepAtivacao = null; }
        if (stepAtivacao === null) return jsonResponse(res, 401, { sucesso: false, mensagem: 'Código inválido' });
        const { codigos, hashes } = gerarCodigosBackup(10);
        const r = await supa.atualizarTotp(sessao.email, {
            totpAtivado: true,
            totpAtivadoEm: new Date().toISOString(),
            totpBackupCodes: hashes,
            totpLastStep: stepAtivacao
        });
        if (!r.sucesso) return jsonResponse(res, 500, r);
        registrarAuditoria(req, sessao.email, '2fa.ativado', {});
        return jsonResponse(res, 200, { sucesso: true, backupCodes: codigos });
    }

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

    const ROTAS_PERMITIDAS_SEM_2FA = new Set([
        '/api/auth/site/me',
        '/api/auth/site/logout',
        '/api/auth/site/2fa/setup',
        '/api/auth/site/2fa/ativar'
    ]);
    if (sessao.precisa2fa && !ROTAS_PERMITIDAS_SEM_2FA.has(url)) {
        return jsonResponse(res, 403, { sucesso: false, mensagem: '2FA obrigatório. Configure em /conta/2fa.', precisa2fa: true });
    }

    // ===== APARÊNCIA (por usuário, sincroniza entre dispositivos) =====
    if (req.method === 'GET' && url === '/api/aparencia') {
        const aparencia = await supa.buscarAparencia(sessao.email);
        return jsonResponse(res, 200, { sucesso: true, aparencia: aparencia || null });
    }
    if (req.method === 'PUT' && url === '/api/aparencia') {
        const body = await lerJsonBody(req);
        // Aceita apenas objeto plano; rejeita primitivos / arrays / null vindos do cliente.
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return jsonResponse(res, 400, { sucesso: false, mensagem: 'Payload inválido' });
        }
        // Limite extra para não estourar JSONB com bgImage gigante (lerJsonBody já corta em 5 MB).
        try {
            if (JSON.stringify(body).length > 4 * 1024 * 1024) {
                return jsonResponse(res, 413, { sucesso: false, mensagem: 'Aparência excede 4 MB' });
            }
        } catch {
            return jsonResponse(res, 400, { sucesso: false, mensagem: 'Payload inválido' });
        }
        const r = await supa.salvarAparencia(sessao.email, body);
        return jsonResponse(res, r.sucesso ? 200 : 500, r);
    }

    // ===== ADMIN =====
    if (url.startsWith('/api/admin/')) {
        if (!sessao.isAdmin) return jsonResponse(res, 403, { sucesso: false, mensagem: 'Apenas admin' });

        // Auditoria: só super-admin. Sem segredos (ts/evento/email/ip/ua), sem senha exigida.
        if (req.method === 'GET' && url === '/api/admin/auditoria') {
            if (!ehSuperAdmin(sessao.email)) {
                return jsonResponse(res, 403, { sucesso: false, mensagem: 'Acesso restrito ao super-admin' });
            }
            return jsonResponse(res, 200, { sucesso: true, entradas: lerAuditoria(500) });
        }

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
        ctx.tasks.addTask(`Automute: ${resultado.tag}`, parar, { usuario: resultado.tag, userId });
        return jsonResponse(res, 200, { sucesso: true, tag: resultado.tag });
    }

    if (req.method === 'POST' && url === '/api/automute/remove') {
        const body = await lerJsonBody(req);
        const userId = String(body.userId || '').trim();
        const r = ctx.automute.remover(userId);
        if (!r.sucesso) return jsonResponse(res, 404, { sucesso: false, mensagem: 'Não estava no automute' });
        for (const t of ctx.tasks.getTasks()) {
            if (t.data?.userId === userId && t.name?.startsWith('Automute')) {
                await ctx.tasks.removeTask(t.id);
            }
        }
        return jsonResponse(res, 200, { sucesso: true, tag: r.tag });
    }

    if (req.method === 'POST' && url === '/api/automute/clear') {
        const ids = ctx.automute.listar().map((u) => u.userId);
        for (const t of ctx.tasks.getTasks()) {
            if (ids.includes(t.data?.userId) && t.name?.startsWith('Automute')) {
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
                    u = await comTimeout(ctx.cliente.users.fetch(userId).catch(() => null), 8000, null);
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
            const publicFlagsRaw = typeof u.flags?.bitfield === 'number' || typeof u.flags?.bitfield === 'bigint'
                ? String(u.flags.bitfield)
                : null;

            const premiumTipo = { 0: 'Nenhum', 1: 'Nitro Classic', 2: 'Nitro', 3: 'Nitro Basic' };

            let profile = null;
            try {
                const p = await comTimeout(u.getProfile(), 8000, null);
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
                              verified: !!c.verified,
                              metadata: c.metadata || null
                          }))
                        : [],
                    purchasedFlags: pu.purchased_flags ?? p?.purchased_flags ?? null,
                    premiumUsageFlags: pu.premium_usage_flags ?? p?.premium_usage_flags ?? null,
                    applicationRoleConnections: Array.isArray(p?.application_role_connections)
                        ? p.application_role_connections.length
                        : 0,
                    badgesIds: Array.isArray(p?.badges)
                        ? p.badges.map((b) => ({ id: b.id, description: b.description || null, icon: b.icon || null, link: b.link || null }))
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

            const tipoRel = ctx.cliente.relationships?.cache?.get(u.id) || null;
            const relacionamento = tipoRel ? {
                tipo: tipoRel,
                rotulo: TIPOS_RELACIONAMENTO[tipoRel] || 'Desconhecido'
            } : null;

            let nota = null;
            try {
                const r = await comTimeout(ctx.cliente.api.users['@me'].notes[u.id].get(), 6000, null);
                nota = r?.note ? String(r.note) : null;
            } catch {}

            const presenca = obterPresencaCompartilhada(ctx.cliente, u.id);
            const snowflake = decodificarSnowflake(u.id);
            const downloads = montarDownloadsMidia(u);

            // Caminho normal (fetch nativo OK): Discord nativo + tracker API já
            // cobrem tudo. Não chamamos discordlookup nem Lanyard aqui — o
            // discordlookup (3 tentativas sequenciais, até ~12s) fica só no
            // fallback do catch, quando o fetch nativo falha; o Lanyard saiu por
            // ser redundante com presence/activities da tracker.
            const tracker = await consultarTrackerAPI(u.id).catch(() => null);

            const historico = userHistory.getHistory(u.id) || { usernames: [], globalNames: [], avatars: [], banners: [] };
            const voz = voiceHistory.getVoiceHistory(u.id) || null;

            // Consulta AO VIVO: olha o voiceStates cache de cada guild compartilhada
            // pra ver se o alvo está em algum canal de voz agora. Funciona mesmo
            // sem nenhum histórico — é o que o cliente Discord mostra em "No
            // canal X" no perfil.
            let vozAoVivo = null;
            try {
                for (const g of ctx.cliente.guilds.cache.values()) {
                    const vs = g.voiceStates?.cache?.get(u.id);
                    if (!vs || !vs.channelId) continue;
                    const canal = vs.channel || g.channels?.cache?.get(vs.channelId) || null;
                    const outros = [];
                    if (canal?.members) {
                        for (const m of canal.members.values()) {
                            if (m.id === u.id) continue;
                            outros.push({
                                id: m.id,
                                name: m.displayName || m.nickname || m.user?.globalName || m.user?.username || null,
                                bot: !!m.user?.bot,
                                avatar: m.user?.displayAvatarURL?.({ size: 64, dynamic: true }) || null
                            });
                        }
                    }
                    vozAoVivo = {
                        guildId: g.id,
                        guildName: g.name || null,
                        guildIcon: g.iconURL?.({ size: 64 }) || null,
                        channelId: vs.channelId,
                        channelName: canal?.name || null,
                        selfMute: !!vs.selfMute,
                        selfDeaf: !!vs.selfDeaf,
                        serverMute: !!vs.mute,
                        serverDeaf: !!vs.deaf,
                        streaming: !!vs.streaming,
                        video: !!vs.selfVideo,
                        membros: outros
                    };
                    break;
                }
            } catch {}
            const fmtTs = (ts) => ts ? new Date(ts).toISOString() : null;
            const historicoNomes = (historico.usernames || []).slice(0, -1).map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) }));
            const historicoGlobais = (historico.globalNames || []).slice(0, -1).map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) }));
            const historicoAvatars = (historico.avatars || []).slice(0, -1).map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) }));
            const historicoBanners = (historico.banners || []).slice(0, -1).map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) }));

            // Sem discordlookup no caminho normal: o enriquecimento externo só
            // existe no fallback. Aqui os dados nativos já bastam.
            const enriquecimento = null;

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
                    publicFlagsRaw,
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
                    purchasedFlags: profile?.purchasedFlags ?? null,
                    premiumUsageFlags: profile?.premiumUsageFlags ?? null,
                    applicationRoleConnections: profile?.applicationRoleConnections ?? 0,
                    badgesIds: profile?.badgesIds || [],
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
                    lanyard: null,
                    vozAoVivo,
                    voz: voz ? {
                        ativa: voz.ativa ? {
                            ...voz.ativa,
                            joinedAt: fmtTs(voz.ativa.joinedAt),
                            leftAt: fmtTs(voz.ativa.leftAt)
                        } : null,
                        sessoes: (voz.sessoes || []).map((s) => ({
                            ...s,
                            joinedAt: fmtTs(s.joinedAt),
                            leftAt: fmtTs(s.leftAt),
                            duracaoMs: s.leftAt && s.joinedAt ? (s.leftAt - s.joinedAt) : null
                        }))
                    } : null,
                    externo: enriquecimento,
                    tracker
                }
            });
        } catch (erro) {
            // Discord retorna 40001 para users.fetch em IDs que não compartilham
            // servidor/amizade com o selfbot. Caímos no lookup externo para mostrar
            // pelo menos badges, banner, data de criação. Se nem o externo responder,
            // ainda devolvemos ID + data de criação derivada do snowflake.
            const codigo = erro?.code || erro?.httpStatus || erro?.status || null;
            const ehSemAcesso = codigo === 40001 || codigo === 50001 || codigo === 401 || codigo === 403;

            // Snowflake data de criação (sempre derivável de qualquer ID válido).
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

            // Fallback (fetch nativo falhou, ex.: 40001): aqui o discordlookup é a
            // rede de segurança que ainda traz badges/banner/data de criação.
            const [externo, tracker] = await Promise.all([
                consultarLookupExterno(userId).catch(() => null),
                consultarTrackerAPI(userId).catch(() => null)
            ]);
            const lanyard = null;
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
                    lanyard,
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
                    } : null,
                    tracker
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
            // Começamos com 4 lotes (~400 msgs). Se nenhuma chamada apareceu nesse
            // intervalo, expandimos até 20 lotes (~2000 msgs) — assim mesmo uma
            // call antiga é encontrada. Continua parando ao esgotar a DM.
            const MAX_LOTES_INICIAL = 4;
            const MAX_LOTES_LARGO = 20;
            let achouCall = false;
            for (let i = 0; i < MAX_LOTES_LARGO; i++) {
                const opcoes = { limit: 100 };
                if (antesDe) opcoes.before = antesDe;
                const lote = await canal.messages.fetch(opcoes).catch(() => null);
                if (!lote || lote.size === 0) break;
                for (const m of lote.values()) {
                    todas.push(m);
                    if (m.type === 'CALL' || m.call) achouCall = true;
                }
                antesDe = lote.last().id;
                if (lote.size < 100) break;
                if (i + 1 >= MAX_LOTES_INICIAL && achouCall) break;
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
            const chamadasRecentesPrimeiro = chamadas.slice().reverse();
            const ultimaChamada = chamadasRecentesPrimeiro[0] || null;

            return jsonResponse(res, 200, {
                sucesso: true,
                historico: {
                    canalId: canal.id,
                    totalCarregadas: todas.length,
                    primeiraMensagemEm: primeira?.createdAt?.toISOString?.() || null,
                    ultimaMensagemEm: ultima?.createdAt?.toISOString?.() || null,
                    ultimaChamada,
                    chamadas: chamadasRecentesPrimeiro,
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

    if (req.method === 'POST' && url === '/api/userinfo/mensagens-servidores') {
        const body = await lerJsonBody(req);
        const userId = String(body.userId || '').trim();
        const limiteServidores = Math.min(Math.max(Number(body.limiteServidores) || 8, 1), 20);
        if (!userId) return jsonResponse(res, 400, { sucesso: false, mensagem: 'ID obrigatório' });
        if (!ctx.cliente) return jsonResponse(res, 400, { sucesso: false, mensagem: 'Conta Discord não conectada' });
        try {
            // Servidores mutuos: onde o alvo aparece no member cache.
            const servidores = ctx.cliente.guilds.cache.filter((g) => g.members?.cache?.has(userId));
            const lista = Array.from(servidores.values()).slice(0, limiteServidores);
            const resultados = [];
            for (const guild of lista) {
                const item = { guildId: guild.id, guildName: guild.name || null, mensagens: [], erro: null };
                try {
                    // GET /guilds/:id/messages/search?author_id=...&limit=10
                    const r = await ctx.cliente.api.guilds[guild.id].messages.search.get({
                        query: { author_id: userId, limit: 10, include_nsfw: true }
                    });
                    const grupos = Array.isArray(r?.messages) ? r.messages : [];
                    for (const grupo of grupos) {
                        const m = Array.isArray(grupo) ? grupo.find((x) => x?.hit) || grupo[0] : grupo;
                        if (!m) continue;
                        const canal = guild.channels?.cache?.get(m.channel_id) || null;
                        const anexos = Array.isArray(m.attachments) ? m.attachments : [];
                        item.mensagens.push({
                            id: m.id,
                            channelId: m.channel_id,
                            channelName: canal?.name || null,
                            criadoEm: m.timestamp || null,
                            conteudo: String(m.content || '').slice(0, 500),
                            anexos: anexos.length,
                            primeiraImagem: anexos.find((a) => (a.content_type || '').startsWith('image/'))?.proxy_url || anexos[0]?.proxy_url || null,
                            editado: !!m.edited_timestamp,
                            link: `https://discord.com/channels/${guild.id}/${m.channel_id}/${m.id}`
                        });
                    }
                    item.total = typeof r?.total_results === 'number' ? r.total_results : item.mensagens.length;
                } catch (e) {
                    const codigo = e?.code || e?.httpStatus || null;
                    item.erro = codigo === 50001 || codigo === 50013
                        ? 'Sem permissão de leitura neste servidor.'
                        : (e?.message || 'Falha na busca');
                }
                resultados.push(item);
                // pequena pausa para suavizar rate limit do search
                await new Promise((rs) => setTimeout(rs, 350));
            }
            return jsonResponse(res, 200, {
                sucesso: true,
                totalServidoresMutuos: servidores.size,
                servidoresConsultados: resultados.length,
                resultados
            });
        } catch (erro) {
            return jsonResponse(res, 500, { sucesso: false, mensagem: 'Falha ao buscar mensagens: ' + (erro?.message || 'erro desconhecido') });
        }
    }

    // ===== ACOES =====
    if (req.method === 'POST' && url === '/api/acoes/remover-amigos') {
        const r = await removerTodosAmigosWeb(ctx); return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }
    if (req.method === 'GET' && url === '/api/servidores') {
        const lista = (ctx.cliente.guilds.cache.map((g) => g) || [])
            .map((g) => ({
                id: g.id,
                nome: g.name,
                membros: g.memberCount || (g.members?.cache?.size ?? 0),
                dono: g.ownerId === ctx.cliente.user?.id
            }))
            .sort((a, b) => a.nome.localeCompare(b.nome));
        return jsonResponse(res, 200, { sucesso: true, total: lista.length, servidores: lista });
    }
    if (req.method === 'POST' && url === '/api/acoes/sair-servidores') {
        const body = await lerJsonBody(req);
        const r = await removerTodosServidoresWeb(ctx, body); return jsonResponse(res, r.sucesso ? 200 : 400, r);
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
    if (req.method === 'POST' && url === '/api/acoes/clonar-canal') {
        const r = await clonarCanalWeb(ctx, await lerJsonBody(req)); return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }
    if (req.method === 'GET' && url === '/api/scraper/zip') {
        // Baixa os anexos de um canal e devolve um ZIP direto pro navegador do usuário.
        // (Funciona no painel hospedado: o arquivo vai pro PC de quem está acessando.)
        if (!ctx.cliente) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', ...headersSeguranca() });
            return res.end('Nenhuma conta Discord conectada.');
        }
        const params = new URL(req.url, 'http://local').searchParams;
        const canalOrigemId = String(params.get('canalOrigem') || '').trim();
        const tipoArquivo = String(params.get('tipoArquivo') || 'todos').trim();
        const canal = ctx.cliente.channels.cache.get(canalOrigemId);
        if (!canal) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...headersSeguranca() });
            return res.end('Canal de origem não encontrado.');
        }

        const arquivos = [];
        let ultimoId = null;
        try {
            while (true) {
                const fetched = await canal.messages.fetch({ limit: 100, ...(ultimoId && { before: ultimoId }) });
                if (fetched.size === 0) break;
                for (const m of fetched.values()) {
                    for (const a of m.attachments.values()) {
                        if (isValidFileType(a.url, tipoArquivo)) arquivos.push({ url: a.url, name: a.name || null });
                    }
                }
                ultimoId = fetched.lastKey();
                await new Promise((r) => setTimeout(r, 200));
            }
        } catch (e) {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', ...headersSeguranca() });
                res.end('Erro ao coletar anexos: ' + e.message);
            }
            return;
        }

        if (arquivos.length === 0) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...headersSeguranca() });
            return res.end('Nenhum arquivo desse tipo encontrado no canal.');
        }

        res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="scraper-${canalOrigemId}.zip"`,
            ...headersSeguranca()
        });

        const zip = new yazl.ZipFile();
        zip.outputStream.pipe(res);
        const usados = new Set();
        for (let i = 0; i < arquivos.length; i++) {
            try {
                const r = await fetch(arquivos[i].url);
                if (!r.ok) continue;
                const ab = await r.arrayBuffer();
                let nome = arquivos[i].name
                    || decodeURIComponent(String(arquivos[i].url).split('?')[0].split('/').pop())
                    || `arquivo_${i}`;
                if (usados.has(nome)) {
                    const ponto = nome.lastIndexOf('.');
                    nome = ponto > 0 ? `${nome.slice(0, ponto)}_${i}${nome.slice(ponto)}` : `${nome}_${i}`;
                }
                usados.add(nome);
                zip.addBuffer(Buffer.from(ab), nome, { compress: false });
            } catch { /* pula arquivo com erro */ }
        }
        zip.end();
        return;
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
            'proteger': protegerUsuarioWeb,
            'proteger-eu': protegerMeuWeb
        };
        if (sub === 'listar') return jsonResponse(res, 200, listarMembrosCallWeb(ctx, body));
        if (sub === 'minha') return jsonResponse(res, 200, listarMinhaCallWeb(ctx));
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
    if (req.method === 'POST' && url === '/api/zaralho/auto-reagir') {
        const r = await autoReagirWeb(ctx, await lerJsonBody(req)); return jsonResponse(res, r.sucesso ? 200 : 400, r);
    }
    if (req.method === 'GET' && url === '/api/zaralho/emojis') {
        const r = await listarEmojisCustomWeb(ctx); return jsonResponse(res, 200, r);
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

async function handleRequest(req, res) {
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
    if (req.method === 'GET' && url === '/admin/auditoria') {
        fs.readFile(path.join(__dirname, '..', 'ui', 'auditoria.html'), (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain', ...headersSeguranca() });
                res.end('Erro ao carregar página');
                return;
            }
            enviarComprimido(req, res, 200, 'text/html; charset=utf-8', data);
        });
        return;
    }
    if (req.method === 'GET' && (url === '/login' || url === '/conta/2fa')) {
        const arquivo = url === '/login' ? 'login.html' : 'conta-2fa.html';
        fs.readFile(path.join(__dirname, '..', 'ui', arquivo), (err, data) => {
            if (err) { res.writeHead(500, { 'Content-Type': 'text/plain', ...headersSeguranca() }); res.end('Erro'); return; }
            enviarComprimido(req, res, 200, 'text/html; charset=utf-8', data);
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
    if (req.method === 'GET' && /^\/ui\/assets\/[a-zA-Z0-9_-]+\.svg$/.test(url)) {
        const nome = url.substring('/ui/assets/'.length);
        fs.readFile(path.join(__dirname, '..', 'ui', 'assets', nome), (err, data) => {
            if (err) { res.writeHead(404, { 'Content-Type': 'text/plain', ...headersSeguranca() }); res.end('Not found'); return; }
            res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400', ...headersSeguranca() });
            res.end(data);
        });
        return;
    }
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        const sessao = await resolverSessao(req);
        if (!sessao || sessao.precisa2fa) {
            res.writeHead(302, { Location: '/login', ...headersSeguranca() });
            res.end();
            return;
        }
        fs.readFile(htmlPath(), (err, data) => {
            if (err) { res.writeHead(500, { 'Content-Type': 'text/plain', ...headersSeguranca() }); res.end('Erro ao carregar UI'); return; }
            enviarComprimido(req, res, 200, 'text/html; charset=utf-8', data);
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
