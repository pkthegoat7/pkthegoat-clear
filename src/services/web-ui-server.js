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
    elevadorWeb,
    coleiraWeb,
    protegerUsuarioWeb,
    nicknameBloqueadoWeb,
    blacklistChatWeb,
    antiDMWeb
} = require('./web-actions');
const { obterConfig, atualizarConfig } = require('../config/configuracao');
const { validarToken, buscarTokensWindows } = require('./tokens');

const PORTA_INICIAL = Number(process.env.PORT) || 4147;
const HOST = process.env.PKTHEGOAT_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const PORTA_FIXA = !!process.env.PORT;
const MAX_TENTATIVAS = PORTA_FIXA ? 0 : 10;
const SESSION_COOKIE = 'pkthegoat_sid';

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

function jsonResponse(res, statusCode, body, extraHeaders = {}) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
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
    const useSecure = process.env.PKTHEGOAT_SECURE_COOKIES === '1';
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
        const r = await autenticar(body.email, body.senha);
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
        return jsonResponse(res, 200, { sucesso: true, usuario: { email: sessao.email, isAdmin: sessao.isAdmin } });
    }

    if (req.method === 'POST' && url === '/api/auth/site/logout') {
        removerSessao(sessao.sid);
        clearSessionCookie(res);
        return jsonResponse(res, 200, { sucesso: true });
    }

    if (req.method === 'POST' && url === '/api/auth/site/password') {
        const body = await lerJsonBody(req);
        const r = await trocarSenha(sessao.email, body.senhaNova);
        return jsonResponse(res, r.sucesso ? 200 : 400, r);
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
            const r = await trocarSenha(body.email, body.senhaNova);
            if (r.sucesso) removerTodasSessoesDoUsuario(body.email);
            return jsonResponse(res, r.sucesso ? 200 : 400, r);
        }
        return jsonResponse(res, 404, { sucesso: false, mensagem: 'Endpoint admin inexistente' });
    }

    // Daqui pra baixo: precisa do contexto do usuário
    const ctx = obterContexto(sessao.email);

    // ===== AUTH DISCORD (por usuário) =====
    if (req.method === 'GET' && url === '/api/auth/status') {
        return jsonResponse(res, 200, ctx.snapshotAuth());
    }

    if (req.method === 'POST' && url === '/api/auth/login') {
        const body = await lerJsonBody(req);
        const token = String(body.token || '').replace(/"/g, '').trim();
        if (!token) return jsonResponse(res, 400, { sucesso: false, mensagem: 'Token obrigatória' });
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

    // ===== USER INFO =====
    if (req.method === 'POST' && url === '/api/userinfo') {
        const body = await lerJsonBody(req);
        const userId = String(body.userId || '').trim();
        if (!userId) return jsonResponse(res, 400, { sucesso: false, mensagem: 'ID obrigatório' });
        try {
            const u = await ctx.cliente.users.fetch(userId, { force: true });
            const flags = u.flags?.toArray?.() || [];
            return jsonResponse(res, 200, {
                sucesso: true,
                usuario: {
                    id: u.id, tag: u.tag, username: u.username, globalName: u.globalName || null,
                    discriminator: u.discriminator,
                    avatar: u.displayAvatarURL?.({ size: 512, dynamic: true }) || null,
                    banner: u.bannerURL?.({ size: 1024, dynamic: true }) || null,
                    bot: !!u.bot, system: !!u.system,
                    accentColor: u.hexAccentColor || null,
                    badges: flags,
                    createdAt: u.createdAt?.toISOString?.() || null
                }
            });
        } catch {
            return jsonResponse(res, 404, { sucesso: false, mensagem: 'Usuário não encontrado' });
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

    // ===== TOKENS (por usuário) =====
    if (req.method === 'GET' && url === '/api/tokens') {
        return jsonResponse(res, 200, { sucesso: true, tokens: await listarTokensUsuario(sessao.email) });
    }
    if (req.method === 'POST' && url === '/api/tokens/add') {
        const body = await lerJsonBody(req);
        const token = String(body.token || '').replace(/"/g, '').trim();
        if (!token) return jsonResponse(res, 400, { sucesso: false, mensagem: 'Token obrigatória' });
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
        res.writeHead(200, { 'Content-Type': 'text/plain' });
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
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Erro ao carregar UI');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
        return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
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
        console.log(`  │  Senha: ${credInicial.senha.padEnd(48)}│`);
        console.log('  │  (salvo em data/first-run-credentials.txt)              │');
        console.log('  │  Troque a senha após o primeiro login!                  │');
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
