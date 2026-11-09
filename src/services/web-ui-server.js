const http = require('http');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { exec } = require('child_process');

const {
	inicializarAdminSeNecessario,
	trocarSenha,
	autenticar,
	loginOuCriarViaDiscord,
	reconfirmarSenha,
	criarSessao,
	validarSessao,
	removerSessao,
	invalidarCacheUsuario,
	buscarUsuario,
	criarDesafio2fa,
	obterDesafio2fa,
	registrarTentativaDesafio,
	consumirDesafio2fa,
	decifrarSegredoTotp,
	verificarCodigoBackup,
	cifrarSegredoTotp,
	gerarCodigosBackup,
	ehPlanoProPorEmail,
	ehPlanoProPorDiscord,
	obterFeatureFlags
} = require('./auth');
const totp = require('./totp');
const {
	obterContexto,
	adicionarTokenUsuario,
	removerTokenUsuario,
	listarTokensUsuario
} = require('./user-context');
const supa = require('./supabase');
const discordOauth = require('./discord-oauth');

// Email do super-admin (dono do app).
const SUPER_ADMIN_EMAIL = 'patricknicoli55@gmail.com';
const ehSuperAdmin = (email) =>
	String(email || '')
		.trim()
		.toLowerCase() === SUPER_ADMIN_EMAIL;

// ====================== PERMISSÕES POR FUNÇÃO (feature flags) ======================
// Cada função tem nível 'todos' (padrão) ou 'pro'.
const FEATURES = [
	{ key: 'farmar', label: 'Farmar horas', pages: ['farmar'], api: ['/api/farmar/', '/api/calls/farmar'] },
	{ key: 'farmar-insignias', label: 'Farmar insígnias', pages: ['insignias-farm'], api: ['/api/farmar/tela', '/api/farmar/jogos'] },
	{ key: 'lookup', label: 'Buscar usuário', pages: ['lookup'], api: ['/api/userinfo', '/api/v1/user'] },
	{ key: 'automute', label: 'Automute', pages: ['automute'], api: ['/api/automute/'] },
	{ key: 'antimute', label: 'Anti Mute', pages: ['antimute'], api: ['/api/calls/proteger'] },
	{ key: 'hit', label: 'Anti Mute — Modo HIT', pages: [], api: [], hit: true, padrao: 'pro' },
	{ key: 'callutils', label: 'Utilidades de Call', pages: ['calls'], api: ['/api/calls/'] },
	{ key: 'limpardm', label: 'Limpar DM', pages: ['limpar-dm'], api: ['/api/acoes/limpar-dm'] },
	{ key: 'limpardms', label: 'Limpar DMs abertas', pages: ['limpar-dms'], api: ['/api/acoes/limpar-dms-abertas'] },
	{ key: 'fechardms', label: 'Fechar DMs', pages: ['fechar-dms'], api: ['/api/acoes/fechar-dms'] },
	{ key: 'amigos', label: 'Remover amigos', pages: ['amigos'], api: ['/api/acoes/remover-amigos', '/api/amigos'] },
	{
		key: 'servidores',
		label: 'Sair de servidores',
		pages: ['servidores'],
		api: ['/api/acoes/sair-servidores', '/api/servidores']
	},
	{ key: 'zaralho', label: 'Zaralho Mode', pages: ['zaralho'], api: ['/api/zaralho/'] },
	{ key: 'backup', label: 'Backup DM', pages: ['backup'], api: ['/api/acoes/backup-dm'] },
	{ key: 'scraper', label: 'Scraper Icons', pages: ['scraper'], api: ['/api/acoes/scraper', '/api/scraper/'] },
	{ key: 'clonar', label: 'Clonar canal', pages: ['clonar-canal'], api: ['/api/acoes/clonar-canal'] },
	{ key: 'tokens', label: 'Tokens', pages: ['tokens'], api: ['/api/tokens'] },
	{ key: 'tarefas', label: 'Tarefas', pages: ['tasks'], api: [] }
];

let _flagsCache = null,
	_flagsCacheAt = 0;
async function flagsCacheadas() {
	const agora = Date.now();
	if (_flagsCache && agora - _flagsCacheAt < 5000) return _flagsCache;
	_flagsCache = await obterFeatureFlags().catch(() => ({}));
	_flagsCacheAt = agora;
	return _flagsCache;
}
function nivelFeature(key, flags) {
	const f = FEATURES.find((x) => x.key === key);
	const nv = flags && flags[key];
	if (nv === 'pro' || nv === 'todos') return nv;
	return (f && f.padrao) || 'todos';
}

async function featuresComNivel() {
	const flags = await flagsCacheadas();
	return FEATURES.map((f) => ({
		key: f.key,
		label: f.label,
		pages: f.pages,
		hit: !!f.hit,
		nivel: nivelFeature(f.key, flags)
	}));
}

// Feature mais específica (maior prefixo de API) que casa com a URL, ou null.
function featurePorUrl(url) {
	let melhor = null,
		melhorLen = -1;
	for (const f of FEATURES) {
		for (const pre of f.api || []) {
			if (url.startsWith(pre) && pre.length > melhorLen) {
				melhor = f;
				melhorLen = pre.length;
			}
		}
	}
	return melhor;
}
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
	sairGruposDMWeb,
	autoReagirWeb,
	listarEmojisCustomWeb,
	obterHypeSquadWeb,
	mudarHypeSquadWeb,
	obterInsigniasWeb,
	farmarTelaWeb,
	farmarJogosWeb
} = require('./web-actions');
const yazl = require('yazl');
const { obterConfig, atualizarConfig } = require('../config/configuracao');
const { validarToken, verificarTokenValida, buscarTokensWindows } = require('./tokens');
const userHistory = require('./user-history');
const voiceHistory = require('./voice-history');

// Tracker próprio (Railway): histórico de nomes/avatares, presença, voz e atividades
// gravados pelo self-bot rodando no servidor. Complementa o lookup externo.
const TRACKER_API_URL = (process.env.TRACKER_API_URL || 'https://tracker-production-db0f.up.railway.app').replace(
	/\/+$/,
	''
);
const TRACKER_API_KEY = process.env.TRACKER_API_KEY || '';

// A API de tracker às vezes devolve o avatar mal-formado: `avatar_hash` já é uma
// URL completa do CDN, e `avatar_url` reembrulha essa URL no template do Discord
// (ex.: .../avatars/{id}/https://.../x.png?size=1024.png?size=256), o que quebra
// a imagem. Normaliza pra uma URL utilizável.
function normalizarAvatarTracker(a) {
	if (!a || typeof a !== 'object') return a;
	let url = a.avatar_url;
	const hash = a.avatar_hash;
	if (typeof hash === 'string' && /^https?:\/\//i.test(hash)) {
		url = hash; // avatar_hash já é uma URL limpa
	} else if (typeof url === 'string') {
		const i = url.indexOf('https://', 8); // pega a URL interna se houver duplicação
		if (i > -1) url = url.slice(i);
		const m = url.match(/^https?:\/\/[^\s]*?\.(?:webp|png|gif|jpg|jpeg)(?:\?[^.\s]*)?/i);
		if (m) url = m[0]; // corta lixo depois da extensão+query da imagem
	}
	return { ...a, avatar_url: url };
}

async function consultarTrackerAPI(userId) {
	if (!TRACKER_API_KEY) return null;
	const headers = { 'X-API-Key': TRACKER_API_KEY, Accept: 'application/json' };
	const get = async (path) => {
		try {
			const ctrl = new AbortController();
			const to = setTimeout(() => ctrl.abort(), 4000);
			const r = await fetch(`${TRACKER_API_URL}${path}`, { headers, signal: ctrl.signal });
			clearTimeout(to);
			if (!r.ok) return null;
			return await r.json();
		} catch {
			return null;
		}
	};
	try {
		const enc = encodeURIComponent(userId);
		const [user, names, avatars, presence, voice, activities, onlineTime, voiceStats, games, mutualGuilds] =
			await Promise.all([
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
		// Enriquece as 2 últimas calls encerradas com participantes + servidor.
		const voiceArr = Array.isArray(voice) ? voice : [];
		const passadasV = voiceArr.filter((v) => v && v.left_at).slice(0, 2);
		const ultimasCalls = await Promise.all(
			passadasV.map(async (v) => {
				let det = null;
				if (v && v.id != null) det = await get(`/voice/sessions/${encodeURIComponent(v.id)}/participants`);
				return {
					...v,
					guild_name: (det && det.guild_name) || null,
					guild_icon: (det && det.guild_icon) || null,
					participantes: det && Array.isArray(det.participants) ? det.participants : []
				};
			})
		);
		return {
			fonte: 'tracker (railway)',
			usuario: user,
			historicoNomes: Array.isArray(names) ? names : [],
			historicoAvatars: Array.isArray(avatars) ? avatars.map(normalizarAvatarTracker) : [],
			presencaRecente: Array.isArray(presence) ? presence : [],
			vozRecente: Array.isArray(voice) ? voice : [],
			atividadesRecentes: Array.isArray(activities) ? activities : [],
			tempoOnline: onlineTime || null,
			statsVoz: voiceStats || null,
			jogos: Array.isArray(games?.games) ? games.games : [],
			servidoresComuns: Array.isArray(mutualGuilds?.guilds) ? mutualGuilds.guilds : [],
			ultimasCalls
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
			const req = https.request(
				{
					method: 'GET',
					host,
					path: pathUrl,
					timeout: 4000,
					headers: { 'User-Agent': 'pkthegoat-clear/1.0', Accept: 'application/json' }
				},
				(resp) => {
					let buf = '';
					resp.on('data', (c) => {
						buf += c;
						if (buf.length > 200_000) {
							resp.destroy();
						}
					});
					resp.on('end', () => {
						if (resp.statusCode !== 200) return resolve(null);
						try {
							resolve(JSON.parse(buf));
						} catch {
							resolve(null);
						}
					});
				}
			);
			req.on('error', () => resolve(null));
			req.on('timeout', () => {
				try {
					req.destroy();
				} catch {}
				resolve(null);
			});
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
	const limite = new Promise((resolve) => {
		timer = setTimeout(() => resolve(fallback), ms);
	});
	return Promise.race([Promise.resolve(promise).catch(() => fallback), limite]).finally(() => clearTimeout(timer));
}

async function consultarLookupExterno(userId) {
	// Tenta a API principal e algumas alternativas até alguma responder.
	const tentativas = [
		() => consultarLookupHTTPS('discordlookup.mesalytic.moe', `/v1/user/${encodeURIComponent(userId)}`),
		() =>
			consultarLookupHTTPS('japi.rest', `/discord/v1/user/${encodeURIComponent(userId)}`).then((d) => d?.data || null),
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
		internalWorker: Number((id & 0x3e0000n) >> 17n),
		internalProcess: Number((id & 0x1f000n) >> 12n),
		increment: Number(id & 0xfffn)
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
			customStatus: custom
				? {
						state: custom.state || null,
						emoji: custom.emoji
							? {
									name: custom.emoji.name || null,
									id: custom.emoji.id || null,
									url: custom.emoji.id
										? `https://cdn.discordapp.com/emojis/${custom.emoji.id}.${custom.emoji.animated ? 'gif' : 'png'}`
										: null
								}
							: null
					}
				: null,
			activities: acts
				.filter((a) => a.type !== 4)
				.map((a) => ({
					type: a.type,
					name: a.name || null,
					details: a.details || null,
					state: a.state || null
				}))
		};
	}
	return null;
}

// PKTHEGOAT_PORT: porta local fixa (sem ligar o "modo produção" como o PORT faz).
// Usada pela build com login Discord, onde o redirect_uri do OAuth precisa de uma
// porta estável (127.0.0.1:4147) registrada no portal do Discord.
const PORTA_LOCAL_FIXA = Number(process.env.PKTHEGOAT_PORT) || 0;
const PORTA_INICIAL = Number(process.env.PORT) || PORTA_LOCAL_FIXA || 4147;
const HOST = process.env.PKTHEGOAT_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const PORTA_FIXA = !!process.env.PORT || !!PORTA_LOCAL_FIXA;
const MAX_TENTATIVAS = PORTA_FIXA ? 0 : 10;
const SESSION_COOKIE = 'pkthegoat_sid';
const OAUTH_STATE_COOKIE = 'pkthegoat_oauth_state';
// Em produção (PORT setado por Railway/Render = HTTPS na borda) tratamos o ambiente
// como público: cookie Secure, e bloqueio de endpoints sensíveis ao host local.
const MODO_PRODUCAO = !!process.env.PORT;

// Modo local (PKTHEGOAT_LOCAL=1): build pessoal pra rodar no PC sem login.
// Não abre tela de login nem OAuth; toda requisição já entra como super-admin,
// e os dados (tokens etc.) ficam nos JSON locais ao lado do executável.
// NUNCA deve ficar ligado num deploy público — por isso ignoramos o flag se
// PORT estiver setado (Railway/Render), garantindo que produção sempre exija login.
const MODO_LOCAL = process.env.PKTHEGOAT_LOCAL === '1' && !MODO_PRODUCAO;

// PKTHEGOAT_AUTH=1: mesmo em modo local, EXIGE login (via Discord OAuth2) em vez
// de entrar como super-admin automático. Usado na build distribuída pros usuários.
// Mantém o resto do modo local (storage em arquivo, acesso total às funções).
const MODO_LOCAL_AUTH = MODO_LOCAL && process.env.PKTHEGOAT_AUTH === '1';

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
	if (sucesso) {
		loginTentativas.delete(chave);
		return;
	}
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
setInterval(
	() => {
		const agora = Date.now();
		for (const [chave, cur] of tokenOpHits.entries()) {
			cur.longa = cur.longa.filter((t) => agora - t < TOKEN_LIMIT_LONGA_WINDOW_MS);
			if (cur.longa.length === 0) tokenOpHits.delete(chave);
		}
	},
	5 * 60 * 1000
).unref();

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
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch {
				resolve({});
			}
		});
		req.on('error', () => resolve({}));
	});
}

// CSP precisa permitir 'unsafe-inline' para script/style porque o painel é uma
// SPA single-file com tudo inline. Bloqueia carregamento de scripts externos
// (vetor mais comum de XSS) mas não bloqueia injeção inline — por isso outras
// camadas (sanitização escaparHtml + HttpOnly cookie) continuam importantes.
// A aba "Tela do self" abre um WebSocket para o serviço self-browser (outro
// domínio), então o connect-src precisa permitir esse origin (https + wss).
const SELF_BROWSER_ORIGIN = (process.env.SELF_BROWSER_URL || '').trim().replace(/\/+$/, '');
const CONNECT_EXTRA = SELF_BROWSER_ORIGIN
	? ' ' + SELF_BROWSER_ORIGIN + ' ' + SELF_BROWSER_ORIGIN.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:')
	: '';
const CSP = [
	"default-src 'self'",
	// blob: necessário para o AudioWorklet da aba "Tela do self" (player de áudio).
	// Cloudflare Web Analytics/Insights injeta beacon.min.js quando habilitado
	// na zona. Sem este host o browser gera erro de CSP no console da tela de
	// login; não é dependência do app, mas deixar explícito remove ruído e mantém
	// a política restrita a um domínio conhecido.
	// hCaptcha: pra resolver captcha do Discord dentro do painel (add amigo etc.).
	"script-src 'self' 'unsafe-inline' blob: https://static.cloudflareinsights.com https://hcaptcha.com https://*.hcaptcha.com",
	"worker-src 'self' blob:",
	"style-src 'self' 'unsafe-inline' https://hcaptcha.com https://*.hcaptcha.com",
	"img-src 'self' data: https:",
	"font-src 'self' data:",
	"connect-src 'self' https://cloudflareinsights.com https://hcaptcha.com https://*.hcaptcha.com" + CONNECT_EXTRA,
	// frame-src: miniatura do Discord web (aba Tela do self) + iframe do hCaptcha.
	"frame-src 'self' https://discord.com https://*.discord.com https://hcaptcha.com https://*.hcaptcha.com",
	"frame-ancestors 'self'",
	"base-uri 'self'",
	"form-action 'self'",
	"object-src 'none'"
].join('; ');

function headersSeguranca() {
	const h = {
		'Content-Security-Policy': CSP,
		'X-Content-Type-Options': 'nosniff',
		'X-Frame-Options': 'SAMEORIGIN',
		'Referrer-Policy': 'strict-origin-when-cross-origin',
		// Microfone/câmera liberados para a miniatura do Discord (falar/cam na call).
		'Permissions-Policy':
			'camera=(self "https://discord.com"), microphone=(self "https://discord.com"), display-capture=(self "https://discord.com"), autoplay=*, geolocation=(), payment=(), usb=()',
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
		: process.env.PKTHEGOAT_SECURE_COOKIES === '1' || MODO_PRODUCAO;
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

// Cache da UI principal em memória. Sem isso, cada request de '/' lia ~371KB
// do disco e re-gzipava tudo. Guardamos o buffer bruto + o já comprimido +
// um ETag barato (tamanho+mtime). Recarrega sozinho se o arquivo mudar (dev).
let _uiCache = null;
function carregarUI() {
	const p = htmlPath();
	let stat;
	try {
		stat = fs.statSync(p);
	} catch {
		return null;
	}
	if (_uiCache && _uiCache.mtimeMs === stat.mtimeMs && _uiCache.size === stat.size) {
		return _uiCache;
	}
	const raw = fs.readFileSync(p);
	const gz = zlib.gzipSync(raw, { level: zlib.constants.Z_BEST_COMPRESSION });
	const etag = `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
	_uiCache = { raw, gz, mtimeMs: stat.mtimeMs, size: stat.size, etag };
	return _uiCache;
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

// Sessão fixa do modo local: super-admin, sem 2FA nem troca de senha pendente.
// Reusada em todas as requisições — não há login, então não há cookie/sid real.
const SESSAO_LOCAL = {
	sid: 'local',
	email: SUPER_ADMIN_EMAIL,
	isAdmin: true,
	senhaPrecisaTroca: false,
	totpAtivado: false,
	precisa2fa: false,
	discordId: null,
	usuario: {
		email: SUPER_ADMIN_EMAIL,
		isAdmin: true,
		totpAtivado: false,
		precisa2fa: false,
		senhaPrecisaTroca: false,
		backupCodes: []
	}
};

async function resolverSessao(req) {
	// Modo local SEM exigência de login: entra direto como super-admin.
	// Com PKTHEGOAT_AUTH=1, cai no fluxo normal de sessão (login via Discord).
	if (MODO_LOCAL && !MODO_LOCAL_AUTH) return SESSAO_LOCAL;
	const cookies = parseCookies(req);
	const sid = cookies[SESSION_COOKIE];
	if (!sid) return null;
	const sessao = await validarSessao(sid);
	if (!sessao) return null;
	return { sid, ...sessao };
}

// CSRF defense-in-depth: além do cookie SameSite=Lax, rejeita requisições que
// alteram estado quando o header Origin existe e aponta pra OUTRA origem. Só
// atua em produção (host público). Requisições same-origin do painel sempre
// mandam Origin = host do painel, então não quebra o uso normal; clientes sem
// browser (sem Origin) passam — o SameSite já cobre o vetor de navegador.
const METODOS_ESTADO = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
function hostsPermitidos(req) {
	const set = new Set();
	if (req.headers.host) set.add(String(req.headers.host).toLowerCase());
	if (process.env.PKTHEGOAT_BASE_URL) {
		try {
			set.add(new URL(process.env.PKTHEGOAT_BASE_URL).host.toLowerCase());
		} catch {}
	}
	return set;
}
function origemPermitida(req) {
	if (!MODO_PRODUCAO) return true;
	if (!METODOS_ESTADO.has(req.method)) return true;
	const origin = req.headers.origin;
	if (!origin) return true; // sem Origin: SameSite=Lax cobre o caso do browser
	let host;
	try {
		host = new URL(origin).host.toLowerCase();
	} catch {
		return false;
	}
	return hostsPermitidos(req).has(host);
}

// =========================== HANDLERS DE API ===========================
async function handleApi(req, res, url) {
	// CSRF: bloqueia POST/PUT/DELETE/PATCH vindos de origem cruzada (produção).
	if (!origemPermitida(req)) {
		return jsonResponse(res, 403, { sucesso: false, mensagem: 'Origem não permitida' });
	}
	// Rotas públicas (login do site)
	if (req.method === 'POST' && url === '/api/auth/site/login') {
		const body = await lerJsonBody(req);
		// E-mail tentado, limitado p/ não inflar o log com lixo (nunca grava a senha).
		const emailTentado = String(body.email || '').slice(0, 120);
		// No app local (PKTHEGOAT_AUTH), o login é EXCLUSIVAMENTE via Discord
		// OAuth2 — nem o super-admin entra por senha (ele se vincula pelo
		// SUPERADMIN_DISCORD_ID).
		if (MODO_LOCAL_AUTH) {
			registrarAuditoria(req, emailTentado, 'login.bloqueado', { motivo: 'local-somente-oauth2' });
			return jsonResponse(res, 403, { sucesso: false, mensagem: 'Neste app o login é apenas com o Discord.' });
		}
		// Login por e-mail/senha é exclusivo do super-admin. Todas as demais
		// contas entram apenas via Discord (OAuth2).
		if (!ehSuperAdmin(body.email)) {
			registrarAuditoria(req, emailTentado, 'login.bloqueado', { motivo: 'somente-oauth2' });
			return jsonResponse(res, 403, {
				sucesso: false,
				mensagem: 'Login por e-mail é exclusivo do administrador. Use "Entrar com Discord".'
			});
		}
		const chave = chaveRateLimit(req, body.email);
		if (loginBloqueado(req, chave)) {
			registrarAuditoria(req, emailTentado, 'login.bloqueado', {});
			return jsonResponse(res, 429, {
				sucesso: false,
				mensagem: 'Muitas tentativas. Tente novamente em alguns minutos.'
			});
		}
		const r = await autenticar(body.email, body.senha);
		registrarTentativaLogin(req, chave, r.sucesso);
		registrarAuditoria(req, emailTentado, r.sucesso ? 'login.sucesso' : 'login.falha', {});
		if (!r.sucesso) return jsonResponse(res, 401, r);
		// Se o usuário tem 2FA ativo, não cria sessão ainda: emite um desafio.
		// No modo local o 2FA é desligado (é Supabase-only; não há como validar).
		const u2fa = await buscarUsuario(r.usuario.email);
		if (u2fa && u2fa.totpAtivado && !MODO_LOCAL) {
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
			return jsonResponse(res, 401, {
				sucesso: false,
				mensagem: 'Desafio inválido ou expirado. Faça login novamente.'
			});
		}
		// Rate-limit por IP, igual ao login. O cap de tentativas por desafio
		// (DESAFIO_MAX_TENT) é o backstop principal contra brute-force dos 6 dígitos.
		const chave = chaveRateLimit(req, desafio.email);
		if (loginBloqueado(req, chave)) {
			registrarAuditoria(req, desafio.email, 'login.bloqueado', { fase: '2fa' });
			return jsonResponse(res, 429, {
				sucesso: false,
				mensagem: 'Muitas tentativas. Tente novamente em alguns minutos.'
			});
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
		} catch {
			stepUsado = null;
		}
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
		const troca = await discordOauth.trocarCodigoDetalhado(code, discordRedirectUri(req));
		if (!troca.sucesso) {
			const motivo = troca.erro === 'invalid_client'
				? 'discord_config'
				: (troca.erro === 'invalid_grant' ? 'discord_redirect' : 'discord_token');
			registrarAuditoria(req, '', 'login.discord.falha', {
				motivo,
				discordErro: troca.erro,
				status: troca.status,
				redirectUri: discordRedirectUri(req)
			});
			res.writeHead(302, { Location: `/login?erro=${motivo}`, 'Set-Cookie': limparState, ...headersSeguranca() });
			return res.end();
		}
		const perfil = await discordOauth.buscarUsuario(troca.accessToken);
		if (!perfil) {
			registrarAuditoria(req, '', 'login.discord.falha', { motivo: 'discord_profile' });
			return redirecionarErro();
		}
		const r = await loginOuCriarViaDiscord(perfil);
		if (!r.sucesso) {
			registrarAuditoria(req, perfil.email || '', 'login.discord.falha', { motivo: r.mensagem });
			return redirecionarErro();
		}
		// Se a conta tem 2FA ativo, o login via Discord NÃO cria sessão sozinho:
		// exige o segundo fator, igual ao login por senha. Emite um desafio e
		// manda pro /login concluir o TOTP (mesmo endpoint /api/auth/site/2fa).
		// Sem isso, quem controlasse a conta Discord entraria driblando o 2FA.
		// No modo local o 2FA é desligado (Supabase-only; sem validação possível).
		const uDiscord = await buscarUsuario(r.email);
		if (uDiscord && uDiscord.totpAtivado && !MODO_LOCAL) {
			const desafio = criarDesafio2fa(r.email);
			registrarAuditoria(req, r.email, 'login.discord.sucesso', { discordId: perfil.id, etapa: '2fa-pendente' });
			res.writeHead(302, {
				Location: `/login?desafio2fa=${encodeURIComponent(desafio)}`,
				'Set-Cookie': limparState,
				...headersSeguranca()
			});
			return res.end();
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

	// Permissões por função: bloqueia (403) endpoints de funções marcadas como
	// "pro" quando o usuário não é pro. Só roda quando a URL casa com uma função.
	if (sessao) {
		const feat = featurePorUrl(url);
		if (feat) {
			const flags = await flagsCacheadas();
			if (
				nivelFeature(feat.key, flags) === 'pro' &&
				!ehSuperAdmin(sessao.email) &&
				!(await ehPlanoProPorDiscord(sessao.discordId))
			) {
				return jsonResponse(res, 403, { sucesso: false, mensagem: `Função "${feat.label}" é exclusiva do plano pro.` });
			}
		}
	}

	if (req.method === 'GET' && url === '/api/auth/site/me') {
		// Reaproveita o usuário já resolvido na sessão (sem novo fetch) e roda as
		// duas consultas restantes em paralelo em vez de em série.
		const u = sessao.usuario;
		// Modo local SEM login = usuário único com acesso total: libera as funções
		// "pro" na UI. Com login (multi-usuário), o "pro" segue as regras do site
		// (lista de IDs pro que o super-admin gerencia).
		const [isPro, features] = await Promise.all([
			MODO_LOCAL && !MODO_LOCAL_AUTH ? Promise.resolve(true) : ehPlanoProPorDiscord(sessao.discordId),
			featuresComNivel()
		]);
		return jsonResponse(res, 200, {
			sucesso: true,
			usuario: {
				email: sessao.email,
				isAdmin: sessao.isAdmin,
				isSuperAdmin: ehSuperAdmin(sessao.email),
				isPro,
				features,
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
		if (r.sucesso) invalidarCacheUsuario(sessao.email);
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
		try {
			stepAtivacao = totp.verificarComStep(decifrarSegredoTotp(u.totpSecretCifrado), String(body.codigo || '').trim());
		} catch {
			stepAtivacao = null;
		}
		if (stepAtivacao === null) return jsonResponse(res, 401, { sucesso: false, mensagem: 'Código inválido' });
		const { codigos, hashes } = gerarCodigosBackup(10);
		const r = await supa.atualizarTotp(sessao.email, {
			totpAtivado: true,
			totpAtivadoEm: new Date().toISOString(),
			totpBackupCodes: hashes,
			totpLastStep: stepAtivacao
		});
		if (!r.sucesso) return jsonResponse(res, 500, r);
		invalidarCacheUsuario(sessao.email);
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
			totpSecretCifrado: null,
			totpAtivado: false,
			totpBackupCodes: null,
			totpAtivadoEm: null
		});
		if (!r.sucesso) return jsonResponse(res, 500, r);
		invalidarCacheUsuario(sessao.email);
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
		invalidarCacheUsuario(sessao.email);
		registrarAuditoria(req, sessao.email, '2fa.backup.regenerado', {});
		return jsonResponse(res, 200, { sucesso: true, backupCodes: codigos });
	}

	// ===== Bloqueio enquanto senha não foi trocada =====
	// Usuário com senha inicial (vinda de admin/sistema) só pode chamar /me, /logout
	// e /password até trocar a senha. Isso fecha a janela onde a credencial inicial
	// poderia ser usada para qualquer outra ação.
	const ROTAS_PERMITIDAS_SEM_TROCA = new Set(['/api/auth/site/me', '/api/auth/site/logout', '/api/auth/site/password']);
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
		return jsonResponse(res, 403, {
			sucesso: false,
			mensagem: '2FA obrigatório. Configure em /conta/2fa.',
			precisa2fa: true
		});
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

	// ===== VPN (túnel dividido) =====
	// Mexe na rede do PC onde o GoatCord roda: só no app local e só para o dono.
	if (url.startsWith('/api/vpn/')) {
		if (!MODO_LOCAL || !ehSuperAdmin(sessao.email)) {
			return jsonResponse(res, 403, { sucesso: false, mensagem: 'A VPN só funciona no app local, para o dono do PC.' });
		}
		const vpn = require('./vpn');
		if (!vpn.suportado) return jsonResponse(res, 400, { sucesso: false, mensagem: 'VPN disponível só no Windows.' });
		const ok = (extra = {}) => jsonResponse(res, 200, { sucesso: true, ...extra });
		try {
			if (req.method === 'GET' && url === '/api/vpn/estado') return jsonResponse(res, 200, await vpn.obterEstado());
			if (req.method === 'GET' && url === '/api/vpn/apps') return ok({ apps: await vpn.listarApps() });
			if (req.method === 'POST' && url === '/api/vpn/conectar') {
				const body = await lerJsonBody(req);
				if (body && body.servidor) vpn.salvarAjustes({ servidor: String(body.servidor) });
				vpn.conectar();
				return ok();
			}
			if (req.method === 'POST' && url === '/api/vpn/desconectar') {
				await vpn.desconectar();
				return ok();
			}
			if (req.method === 'POST' && url === '/api/vpn/ajustes') {
				const body = (await lerJsonBody(req)) || {};
				vpn.salvarAjustes(body);
				if (body.prefs && typeof body.prefs === 'object') {
					vpn.salvarPrefs({
						...(typeof body.prefs.autoConectar === 'boolean' ? { autoConectar: body.prefs.autoConectar } : {}),
						...(typeof body.prefs.desligarAoFechar === 'boolean' ? { desligarAoFechar: body.prefs.desligarAoFechar } : {})
					});
				}
				if (body.modo || body.apps || body.servidor) vpn.reaplicarSeLigado();
				return ok();
			}
			if (req.method === 'POST' && url === '/api/vpn/so-discord') {
				const body = (await lerJsonBody(req)) || {};
				return ok(await vpn.ligarSoDiscord({ incluirGoatcord: body.incluirGoatcord === true }));
			}
			if (req.method === 'POST' && url === '/api/vpn/reiniciar-discord') {
				await vpn.reiniciarDiscord();
				return ok();
			}
			if (req.method === 'POST' && url === '/api/vpn/importar') {
				const body = (await lerJsonBody(req)) || {};
				const arquivos = Array.isArray(body.arquivos) ? body.arquivos.slice(0, 50) : [];
				const importados = arquivos.map((a) => vpn.importarTexto(a && a.conteudo, String((a && a.nome) || 'servidor.conf')));
				if (importados[0]) vpn.salvarAjustes({ servidor: importados[importados.length - 1].arquivo });
				return ok({ importados });
			}
			if (req.method === 'POST' && url === '/api/vpn/remover-servidor') {
				const body = (await lerJsonBody(req)) || {};
				vpn.removerServidor(body.arquivo);
				return ok();
			}
			if (req.method === 'POST' && url === '/api/vpn/escolher-exe') {
				// O navegador não revela o caminho de um arquivo escolhido; no app (Electron) usamos o diálogo nativo
				let caminhos = [];
				try {
					const { dialog, BrowserWindow } = require('electron');
					const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, {
						title: 'Escolher programa para a VPN',
						filters: [{ name: 'Programas', extensions: ['exe'] }],
						properties: ['openFile', 'multiSelections']
					});
					caminhos = r.canceled ? [] : r.filePaths;
				} catch {
					return jsonResponse(res, 400, { sucesso: false, mensagem: 'Seletor de arquivos disponível só no app.' });
				}
				return ok({ caminhos });
			}
			if (req.method === 'POST' && url === '/api/vpn/permissao') {
				await vpn.configurarPermissao();
				return ok();
			}
			if (req.method === 'POST' && url === '/api/vpn/instalar-motor') {
				vpn.instalarMotor().catch(() => {});
				return ok();
			}
		} catch (e) {
			return jsonResponse(res, 400, { sucesso: false, mensagem: (e && e.message) || 'Erro na VPN.' });
		}
		return jsonResponse(res, 404, { sucesso: false, mensagem: 'Endpoint da VPN inexistente' });
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
		const token = String(body.token || '')
			.replace(/"/g, '')
			.trim();
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

	// Daqui pra baixo: maioria precisa de cliente Discord conectado.
	const exigeCliente =
		!url.startsWith('/api/tokens') &&
		!url.startsWith('/api/config') &&
		!url.startsWith('/api/rpc') &&
		!url.startsWith('/api/sniper') &&
		!url.startsWith('/api/captcha/') &&
		url !== '/api/convites/mensagens';
	if (exigeCliente && !ctx.cliente) {
		return jsonResponse(res, 503, { sucesso: false, mensagem: 'Cliente Discord não conectado' });
	}

	// ===== CAPTCHA (resolver no painel) =====
	if (url.startsWith('/api/captcha/')) {
		const bridge = require('./captcha-bridge');
		if (req.method === 'GET' && url === '/api/captcha/pending') {
			return jsonResponse(res, 200, { sucesso: true, captcha: bridge.pendente(ctx.email) });
		}
		if (req.method === 'POST' && url === '/api/captcha/solve') {
			const body = await lerJsonBody(req);
			const ok = bridge.resolverCaptcha(ctx.email, body.token);
			return jsonResponse(res, ok ? 200 : 400, { sucesso: ok });
		}
		if (req.method === 'POST' && url === '/api/captcha/cancel') {
			bridge.cancelarCaptcha(ctx.email);
			return jsonResponse(res, 200, { sucesso: true });
		}
	}

	// ===== AUTOMUTE =====
	if (req.method === 'POST' && url === '/api/automute/add') {
		const body = await lerJsonBody(req);
		const userId = String(body.userId || '').trim();
		const deafen = body.deafen === true || body.deafen === 'true';
		if (!userId) return jsonResponse(res, 400, { sucesso: false, mensagem: 'ID obrigatório' });
		const resultado = await ctx.automute.adicionar(userId, deafen);
		if (!resultado.sucesso) {
			const msgs = {
				ja_existe: `Usuário já está no automute (${resultado.tag})`,
				usuario_invalido: 'ID inválido ou usuário não encontrado',
				cliente_indisponivel: 'Cliente Discord indisponível'
			};
			return jsonResponse(res, 400, { sucesso: false, mensagem: msgs[resultado.motivo] || 'Erro ao adicionar' });
		}
		const parar = async () => {
			ctx.automute.remover(userId);
		};
		const nomeTask = deafen ? `Automute (+ouvido): ${resultado.tag}` : `Automute: ${resultado.tag}`;
		ctx.tasks.addTask(nomeTask, parar, { usuario: resultado.tag, userId });
		return jsonResponse(res, 200, { sucesso: true, tag: resultado.tag, deafen: resultado.deafen === true });
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
					cli.once('ready', () => {
						clearTimeout(t);
						res2();
					});
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
						try {
							cli.destroy();
						} catch {}
						if (userId) ctx.farmClients.delete(userId);
					}
				});

				// Se o farm falhou, destrói imediatamente o client extra
				if (!r.sucesso) {
					try {
						cli.destroy();
					} catch {}
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

	// ===== FARMAR HORAS (multi-servidor: cada conta no seu próprio alvo) =====
	// Diferente de /api/farmar/multi (várias contas no MESMO canal), aqui cada
	// conta tem o seu próprio canal/servidor. Como uma conta do Discord só pode
	// estar em UMA call por vez (em qualquer servidor), travamos contas repetidas.
	if (req.method === 'POST' && url === '/api/farmar/multi-alvo') {
		const body = await lerJsonBody(req);
		const pares = Array.isArray(body.pares) ? body.pares : [];
		if (!pares.length) return jsonResponse(res, 400, { sucesso: false, mensagem: 'Nenhum par conta/servidor informado' });

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
		const tokensUsados = new Set();  // trava pré-login (por token/self)
		const idsUsados = new Set();     // trava pós-login (por userId real)
		if (ctx.cliente?.user?.id) idsUsados.add(ctx.cliente.user.id);
		let primeira = true;

		for (const par of pares) {
			const alvo = {
				canalId: par.canalId ? String(par.canalId).trim() : null,
				guildId: par.guildId ? String(par.guildId).trim() : null,
				categoriaId: par.categoriaId ? String(par.categoriaId).trim() : null
			};
			const rotulo = par.label || '?';
			if (!alvo.canalId && !alvo.guildId) {
				resultados.push({ label: rotulo, sucesso: false, mensagem: 'Sem canal/servidor informado' });
				continue;
			}
			const resolved = await resolverToken(par.account);
			if (!resolved) {
				resultados.push({ label: rotulo, sucesso: false, mensagem: 'Conta não encontrada' });
				continue;
			}
			const chaveToken = resolved.token === null ? 'self' : resolved.token;
			if (tokensUsados.has(chaveToken)) {
				resultados.push({ label: resolved.label, sucesso: false, mensagem: 'Conta repetida (1 conta = 1 call)' });
				continue;
			}
			tokensUsados.add(chaveToken);

			if (!primeira) await sleep(3);
			primeira = false;

			// Conta atual (self)
			if (resolved.token === null) {
				const r = await farmarHorasWeb(ctx, { ...alvo, accountLabel: ctx.cliente?.user?.tag || 'Conta atual' });
				resultados.push({ label: resolved.label, ...r });
				continue;
			}

			// Conta extra: login num client dedicado
			try {
				const cli = new Client({ checkUpdate: false });
				cli.on('error', () => {});
				const prontoP = new Promise((res2, rej2) => {
					const t = setTimeout(() => rej2(new Error('Timeout aguardando ready')), 20000);
					cli.once('ready', () => { clearTimeout(t); res2(); });
				});
				await cli.login(resolved.token);
				await prontoP;
				await new Promise((res2) => setTimeout(res2, 1500));

				const userId = cli.user?.id;
				// Trava pós-login: mesma conta que o self (ou já usada) por token diferente
				if (userId && idsUsados.has(userId)) {
					try { cli.destroy(); } catch {}
					resultados.push({ label: resolved.label, sucesso: false, mensagem: 'Conta repetida (1 conta = 1 call)' });
					continue;
				}
				if (userId) { idsUsados.add(userId); ctx.farmClients.set(userId, cli); }

				const r = await farmarHorasWeb(ctx, {
					...alvo,
					clientOverride: cli,
					accountLabel: cli.user?.tag || resolved.label,
					onStop: async () => {
						try { cli.destroy(); } catch {}
						if (userId) ctx.farmClients.delete(userId);
					}
				});

				if (!r.sucesso) {
					try { cli.destroy(); } catch {}
					if (userId) ctx.farmClients.delete(userId);
				}
				resultados.push({ label: resolved.label, ...r });
			} catch (e) {
				resultados.push({ label: resolved.label, sucesso: false, mensagem: e.message || 'Falha no login' });
			}
		}

		const okCount = resultados.filter((r) => r.sucesso).length;
		return jsonResponse(res, 200, {
			sucesso: okCount > 0,
			iniciadas: okCount,
			total: resultados.length,
			resultados: resultados.map((r) => ({
				conta: r.label || '?',
				sucesso: !!r.sucesso,
				mensagem: r.mensagem || null,
				taskId: r.taskId || null,
				canal: r.canal || null
			}))
		});
	}

	// ===== FARMAR TELA (compartilhar tela / vídeo) =====
	if (req.method === 'POST' && url === '/api/farmar/tela') {
		const body = await lerJsonBody(req);
		const canalId = String(body.canalId || '').trim();
		if (!canalId) return jsonResponse(res, 400, { sucesso: false, mensagem: 'canalId obrigatório' });
		const r = await farmarTelaWeb(ctx, { canalId, accountLabel: ctx.cliente?.user?.tag || 'Conta atual' });
		return jsonResponse(res, r.sucesso ? 200 : 400, r);
	}

	// ===== FARMAR JOGOS (fake processes) =====
	if (req.method === 'POST' && url === '/api/farmar/jogos') {
		const body = await lerJsonBody(req);
		const qtd = Number(body.qtd) || 10;
		const horas = Number(body.horas) || 24;
		const r = await farmarJogosWeb(ctx, { qtd, horas });
		return jsonResponse(res, r.sucesso ? 200 : 400, r);
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
					u = await comTimeout(
						ctx.cliente.users.fetch(userId).catch(() => null),
						8000,
						null
					);
				}
			}
			if (!u) {
				// Forca o caminho catch, que ja faz fallback via getProfile/externo.
				const e = new Error('Unauthorized');
				e.code = 40001;
				throw e;
			}
			try {
				userHistory.recordUser(u);
			} catch {}
			const flags = u.flags?.toArray?.() || [];
			const publicFlagsRaw =
				typeof u.flags?.bitfield === 'number' || typeof u.flags?.bitfield === 'bigint'
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
									highestRole:
										highest && !ehEveryone
											? {
													name: highest.name,
													color: highest.hexColor && highest.hexColor !== '#000000' ? highest.hexColor : null
												}
											: null
								};
							})
						: [],
					mutualFriendsCount:
						typeof p?.mutual_friends_count === 'number'
							? p.mutual_friends_count
							: Array.isArray(p?.mutual_friends)
								? p.mutual_friends.length
								: 0,
					mutualFriends: Array.isArray(p?.mutual_friends)
						? p.mutual_friends.slice(0, 50).map((f) => {
								const usr = f.user || f;
								const hash = usr?.avatar;
								return {
									id: usr?.id || f.id || null,
									username: usr?.username || null,
									globalName: usr?.global_name || null,
									discriminator: usr?.discriminator || null,
									avatar:
										hash && usr?.id
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
						? p.badges.map((b) => ({
								id: b.id,
								description: b.description || null,
								icon: b.icon || null,
								link: b.link || null
							}))
						: []
				};
			} catch {
				profile = null;
			}

			const primaryGuild = u.primaryGuild
				? {
						identityGuildId: u.primaryGuild.identityGuildId || null,
						identityEnabled: !!u.primaryGuild.identityEnabled,
						tag: u.primaryGuild.tag || null,
						badge: u.guildTagBadgeURL?.() || null
					}
				: null;

			const nameplate = u.collectibles?.nameplate
				? {
						label: u.collectibles.nameplate.label,
						palette: u.collectibles.nameplate.palette,
						asset: u.collectibles.nameplate.asset
					}
				: null;

			const tipoRel = ctx.cliente.relationships?.cache?.get(u.id) || null;
			const relacionamento = tipoRel
				? {
						tipo: tipoRel,
						rotulo: TIPOS_RELACIONAMENTO[tipoRel] || 'Desconhecido'
					}
				: null;

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
			const fmtTs = (ts) => (ts ? new Date(ts).toISOString() : null);
			const historicoNomes = (historico.usernames || [])
				.slice(0, -1)
				.map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) }));
			const historicoGlobais = (historico.globalNames || [])
				.slice(0, -1)
				.map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) }));
			const historicoAvatars = (historico.avatars || [])
				.slice(0, -1)
				.map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) }));
			const historicoBanners = (historico.banners || [])
				.slice(0, -1)
				.map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) }));

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
					voz: voz
						? {
								ativa: voz.ativa
									? {
											...voz.ativa,
											joinedAt: fmtTs(voz.ativa.joinedAt),
											leftAt: fmtTs(voz.ativa.leftAt)
										}
									: null,
								sessoes: (voz.sessoes || []).map((s) => ({
									...s,
									joinedAt: fmtTs(s.joinedAt),
									leftAt: fmtTs(s.leftAt),
									duracaoMs: s.leftAt && s.joinedAt ? s.leftAt - s.joinedAt : null
								}))
							}
						: null,
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
			const accent =
				externo?.accent_color != null ? `#${Number(externo.accent_color).toString(16).padStart(6, '0')}` : null;
			const flags = Array.isArray(externo?.badges) ? externo.badges : [];

			const historico = userHistory.getHistory(userId) || { usernames: [], globalNames: [], avatars: [], banners: [] };
			const fmtTs = (t) => (t ? new Date(t).toISOString() : null);

			const aviso = ehSemAcesso
				? externo
					? 'Discord não libera dados completos para este ID (sem servidor/amizade em comum). Mostrando o que o lookup externo retornou.'
					: 'Discord não libera dados completos para este ID (sem servidor/amizade em comum) e o lookup externo está indisponível. Mostrando apenas ID e data de criação.'
				: externo
					? null
					: 'Falha ao buscar via Discord e lookup externo offline. Mostrando apenas dados derivados do ID.';

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
						usernamesAntigos: (historico.usernames || [])
							.slice(0, -1)
							.map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) })),
						globalNamesAntigos: (historico.globalNames || [])
							.slice(0, -1)
							.map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) })),
						avatarsAntigos: (historico.avatars || [])
							.slice(0, -1)
							.map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) })),
						bannersAntigos: (historico.banners || [])
							.slice(0, -1)
							.map((h) => ({ value: h.value, seenAt: fmtTs(h.seenAt) }))
					},
					externo: externo
						? {
								fonte: 'lookup externo',
								badges: flags,
								accentColor: accent,
								banner: bannerExt,
								avatar: avatarExt,
								createdAt: externo?.created_at || null
							}
						: null,
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

			let canal =
				usuario.dmChannel || ctx.cliente.channels.cache.find((c) => c.type === 'DM' && c.recipient?.id === userId);
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
						duracaoMs: fim ? fim - m.createdTimestamp : null,
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
			const ultimas = textuais
				.slice(-15)
				.reverse()
				.map((m) => ({
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
			return jsonResponse(res, 500, {
				sucesso: false,
				mensagem: 'Falha ao carregar histórico: ' + (erro?.message || 'erro desconhecido')
			});
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
							primeiraImagem:
								anexos.find((a) => (a.content_type || '').startsWith('image/'))?.proxy_url ||
								anexos[0]?.proxy_url ||
								null,
							editado: !!m.edited_timestamp,
							link: `https://discord.com/channels/${guild.id}/${m.channel_id}/${m.id}`
						});
					}
					item.total = typeof r?.total_results === 'number' ? r.total_results : item.mensagens.length;
				} catch (e) {
					const codigo = e?.code || e?.httpStatus || null;
					item.erro =
						codigo === 50001 || codigo === 50013
							? 'Sem permissão de leitura neste servidor.'
							: e?.message || 'Falha na busca';
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
			return jsonResponse(res, 500, {
				sucesso: false,
				mensagem: 'Falha ao buscar mensagens: ' + (erro?.message || 'erro desconhecido')
			});
		}
	}

	// ===== ACOES =====
	if (req.method === 'POST' && url === '/api/acoes/remover-amigos') {
		const r = await removerTodosAmigosWeb(ctx, await lerJsonBody(req));
		return jsonResponse(res, r.sucesso ? 200 : 400, r);
	}
	if (req.method === 'GET' && url === '/api/amigos') {
		const { listarRelacionamentos } = require('./discord');
		const ids = listarRelacionamentos(ctx.cliente, 1) || [];
		const amigos = ids
			.map((id) => {
				const u = ctx.cliente.users?.cache?.get(id);
				return {
					id,
					nome: u?.globalName || u?.username || id,
					username: u?.username || null,
					avatar: u?.displayAvatarURL?.({ size: 64 }) || null
				};
			})
			.sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
		return jsonResponse(res, 200, { sucesso: true, total: amigos.length, amigos });
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
		const r = await removerTodosServidoresWeb(ctx, body);
		return jsonResponse(res, r.sucesso ? 200 : 400, r);
	}
	if (req.method === 'GET' && url === '/api/dms/abertas') {
		const { listarDMsAbertas } = require('./discord');
		const dms = (listarDMsAbertas(ctx.cliente) || [])
			.map((dm) => {
				const r = dm.recipient;
				return {
					id: dm.id,
					userId: r?.id || dm.id,
					nome: r?.globalName || r?.username || dm.name || dm.id,
					avatar: r?.displayAvatarURL?.({ size: 64 }) || null
				};
			})
			.sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
		return jsonResponse(res, 200, { sucesso: true, total: dms.length, dms });
	}
	if (req.method === 'GET' && url === '/api/perfil') {
		const id = String(new URL(req.url, 'http://local').searchParams.get('id') || '').trim();
		if (!/^\d{15,25}$/.test(id)) return jsonResponse(res, 400, { sucesso: false, mensagem: 'ID inválido.' });
		const u = await ctx.cliente.users.fetch(id).catch(() => null);
		if (!u) return jsonResponse(res, 404, { sucesso: false, mensagem: 'Usuário não encontrado.' });
		let criadoEm = null;
		try {
			criadoEm = u.createdAt ? u.createdAt.toLocaleDateString('pt-BR') : null;
		} catch {}
		return jsonResponse(res, 200, {
			sucesso: true,
			perfil: {
				id: u.id,
				username: u.username,
				globalName: u.globalName || null,
				tag: u.tag || null,
				avatar: u.displayAvatarURL?.({ size: 128 }) || null,
				criadoEm
			}
		});
	}
	if (req.method === 'POST' && url === '/api/backup/conta') {
		const body = await lerJsonBody(req);
		const incluir = body.incluir || {};
		const { montarBackupConta, gerarConvitesServidores } = require('./backup-conta');
		const backup = montarBackupConta(ctx.cliente, incluir);
		// Convites por servidor (opcional): gera 1 convite permanente onde há permissão.
		if (incluir.convites && Array.isArray(backup.servidores) && backup.servidores.length) {
			const mapa = await gerarConvitesServidores(ctx.cliente);
			let comConvite = 0;
			for (const s of backup.servidores) {
				const m = mapa[s.id];
				if (!m) continue;
				if (m.code) {
					s.convite_code = m.code;
					s.convite = m.url;
					comConvite++;
				} else if (m.erro) {
					s.convite_erro = m.erro;
				}
			}
			backup.resumo.convites = comConvite;
		}
		return jsonResponse(res, 200, { sucesso: true, backup, resumo: backup.resumo });
	}
	if (req.method === 'POST' && url === '/api/backup/add-friend') {
		const body = await lerJsonBody(req);
		const id = String(body.id || '').trim();
		if (!/^\d{15,25}$/.test(id)) return jsonResponse(res, 400, { sucesso: false, mensagem: 'ID inválido.' });
		try {
			await ctx.cliente.api.users['@me'].relationships[id].put({
				data: {},
				DiscordContext: { location: 'ContextMenu' }
			});
			return jsonResponse(res, 200, { sucesso: true });
		} catch (e) {
			const m = e?.message || String(e);
			const st = e?.httpStatus || e?.status || e?.code;
			let tipo = null;
			if (st === 429 || /rate ?limit|being blocked/i.test(m)) tipo = 'ratelimit';
			else if (/captcha/i.test(m)) tipo = 'captcha';
			return jsonResponse(res, 400, { sucesso: false, mensagem: m, tipo });
		}
	}
	if (req.method === 'POST' && url === '/api/backup/restaurar') {
		const { restaurarContaWeb } = require('./backup-conta');
		const r = await restaurarContaWeb(ctx, await lerJsonBody(req));
		return jsonResponse(res, r.sucesso ? 200 : 400, r);
	}
	if (req.method === 'GET' && url === '/api/dms/grupos') {
		const grupos = [];
		for (const ch of ctx.cliente.channels.cache.values()) {
			if (ch.type !== 'GROUP_DM') continue;
			let nomes = [];
			try {
				if (ch.recipients) nomes = [...ch.recipients.values()].map((u) => u.globalName || u.username || u.id);
			} catch {}
			grupos.push({
				id: ch.id,
				nome: ch.name || nomes.slice(0, 4).join(', ') || 'Grupo sem nome',
				participantes: (ch.recipients?.size ?? nomes.length) + 1,
				avatar: (typeof ch.iconURL === 'function' ? ch.iconURL({ size: 64 }) : null) || null
			});
		}
		grupos.sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
		return jsonResponse(res, 200, { sucesso: true, total: grupos.length, grupos });
	}
	if (req.method === 'POST' && url === '/api/acoes/sair-grupos') {
		const r = await sairGruposDMWeb(ctx, await lerJsonBody(req));
		return jsonResponse(res, r.sucesso ? 200 : 400, r);
	}
	if (req.method === 'POST' && url === '/api/acoes/fechar-dms') {
		const r = await fecharTodasDMsWeb(ctx, await lerJsonBody(req));
		return jsonResponse(res, r.sucesso ? 200 : 400, r);
	}
	if (req.method === 'POST' && url === '/api/acoes/limpar-dm') {
		const r = await limparDMUnicaWeb(ctx, await lerJsonBody(req));
		return jsonResponse(res, r.sucesso ? 200 : 400, r);
	}
	if (req.method === 'POST' && url === '/api/acoes/limpar-dms-abertas') {
		const r = await limparDMsAbertasWeb(ctx, await lerJsonBody(req));
		return jsonResponse(res, r.sucesso ? 200 : 400, r);
	}
	if (req.method === 'POST' && url === '/api/acoes/backup-dm') {
		const r = await backupDMWeb(ctx, await lerJsonBody(req));
		return jsonResponse(res, r.sucesso ? 200 : 400, r);
	}
	if (req.method === 'POST' && url === '/api/acoes/scraper') {
		const r = await scraperIconsWeb(ctx, await lerJsonBody(req));
		return jsonResponse(res, r.sucesso ? 200 : 400, r);
	}
	if (req.method === 'POST' && url === '/api/acoes/clonar-canal') {
		const r = await clonarCanalWeb(ctx, await lerJsonBody(req));
		return jsonResponse(res, r.sucesso ? 200 : 400, r);
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
				let nome =
					arquivos[i].name ||
					decodeURIComponent(String(arquivos[i].url).split('?')[0].split('/').pop()) ||
					`arquivo_${i}`;
				if (usados.has(nome)) {
					const ponto = nome.lastIndexOf('.');
					nome = ponto > 0 ? `${nome.slice(0, ponto)}_${i}${nome.slice(ponto)}` : `${nome}_${i}`;
				}
				usados.add(nome);
				zip.addBuffer(Buffer.from(ab), nome, { compress: false });
			} catch {
				/* pula arquivo com erro */
			}
		}
		zip.end();
		return;
	}

	// ===== CALLS =====
	if (req.method === 'POST' && url.startsWith('/api/calls/')) {
		const body = await lerJsonBody(req);
		const sub = url.slice('/api/calls/'.length);
		const map = {
			desconectar: desconectarTodosCallWeb,
			mover: moverMembrosCallWeb,
			mutar: mutarTodosCallWeb,
			ensurdecer: ensurdecerTodosCallWeb,
			farmar: farmarHorasWeb,
			entrar: entrarCallWeb,
			elevador: elevadorWeb,
			coleira: coleiraWeb,
			proteger: protegerUsuarioWeb,
			'proteger-eu': protegerMeuWeb
		};
		if (sub === 'listar') return jsonResponse(res, 200, listarMembrosCallWeb(ctx, body));
		if (sub === 'minha') return jsonResponse(res, 200, listarMinhaCallWeb(ctx));
		const fn = map[sub];
		if (!fn) return jsonResponse(res, 404, { sucesso: false, mensagem: 'Endpoint inexistente' });
		// O modo HIT do anti-mute é exclusivo do plano pro (validação no servidor,
		// não só na UI — não dá pra confiar no front).
		if (sub === 'proteger-eu' && String(body.modo || '').toLowerCase() === 'hit') {
			const flags = await flagsCacheadas();
			if (
				nivelFeature('hit', flags) === 'pro' &&
				!ehSuperAdmin(sessao.email) &&
				!(await ehPlanoProPorDiscord(sessao.discordId))
			) {
				return jsonResponse(res, 403, { sucesso: false, mensagem: 'O modo HIT é exclusivo do plano pro.' });
			}
		}
		const r = await fn(ctx, body);
		return jsonResponse(res, r.sucesso ? 200 : 400, r);
	}

	// ===== ZARALHO =====
	if (req.method === 'POST' && url === '/api/zaralho/nickname') {
		const r = await nicknameBloqueadoWeb(ctx, await lerJsonBody(req));
		return jsonResponse(res, r.sucesso ? 200 : 400, r);
	}
	if (req.method === 'POST' && url === '/api/zaralho/blacklist') {
		const r = await blacklistChatWeb(ctx, await lerJsonBody(req));
		return jsonResponse(res, r.sucesso ? 200 : 400, r);
	}
	if (req.method === 'POST' && url === '/api/zaralho/antidm') {
		const r = await antiDMWeb(ctx);
		return jsonResponse(res, r.sucesso ? 200 : 400, r);
	}
	if (req.method === 'POST' && url === '/api/zaralho/auto-reagir') {
		const r = await autoReagirWeb(ctx, await lerJsonBody(req));
		return jsonResponse(res, r.sucesso ? 200 : 400, r);
	}
	if (req.method === 'GET' && url === '/api/zaralho/emojis') {
		const r = await listarEmojisCustomWeb(ctx);
		return jsonResponse(res, 200, r);
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

	// ===== INSÍGNIAS & NITRO =====
	if (req.method === 'GET' && url === '/api/conta/insignias') {
		const r = await obterInsigniasWeb(ctx);
		return jsonResponse(res, r.sucesso ? 200 : 400, r);
	}

	// ===== TOKENS (por usuário) =====
	if (req.method === 'GET' && url === '/api/tokens') {
		return jsonResponse(res, 200, { sucesso: true, tokens: await listarTokensUsuario(sessao.email) });
	}
	// Remove automaticamente as tokens salvas que o Discord já rejeita (401).
	// Usado pela aba de Tokens ao abrir. Só apaga o que é comprovadamente
	// inválido; falha de rede/5xx/403 preserva a token.
	if (req.method === 'POST' && url === '/api/tokens/limpar-invalidas') {
		const { listarTokensComValor } = require('./user-context');
		const salvos = await listarTokensComValor(sessao.email);
		const removidas = [];
		for (const t of salvos) {
			const estado = await verificarTokenValida(t.token);
			if (estado === 'invalida') {
				const r = await removerTokenUsuario(sessao.email, t.nome);
				if (r.sucesso) {
					removidas.push(t.nome);
					registrarAuditoria(req, sessao.email, 'token.auto-remover-invalida', { nome: t.nome });
				}
			}
		}
		return jsonResponse(res, 200, { sucesso: true, removidas });
	}
	// Valor do token (decifrado) para a extensão de navegador abrir o Discord web
	// como o self. Só os tokens do próprio usuário; auditado.
	if (req.method === 'POST' && url === '/api/tokens/valor') {
		const body = await lerJsonBody(req);
		const nome = String(body.nome || '').trim();
		if (!nome) return jsonResponse(res, 400, { sucesso: false, mensagem: 'Nome do token obrigatório' });
		const { buscarTokenUsuario } = require('./user-context');
		const alvo = await buscarTokenUsuario(sessao.email, nome);
		if (!alvo || !alvo.token) return jsonResponse(res, 404, { sucesso: false, mensagem: 'Token não encontrado' });
		registrarAuditoria(req, sessao.email, 'token.valor', { nome });
		return jsonResponse(res, 200, { sucesso: true, nome, token: alvo.token });
	}
	if (req.method === 'POST' && url === '/api/tokens/add') {
		const motivo = tokenOpBloqueado(req, sessao);
		if (motivo) return jsonResponse(res, 429, { sucesso: false, mensagem: motivo });
		const body = await lerJsonBody(req);
		const token = String(body.token || '')
			.replace(/"/g, '')
			.trim();
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
		if (!sessao.isAdmin)
			return jsonResponse(res, 403, { sucesso: false, mensagem: 'Apenas admin pode mudar config global' });
		const body = await lerJsonBody(req);
		const permitido = ['delay', 'esperar_fetch', 'cor_painel', 'desativar_rpc'];
		let aplicado = 0;
		for (const k of permitido) {
			if (k in body) {
				atualizarConfig(k, body[k]);
				aplicado++;
			}
		}
		return jsonResponse(res, 200, { sucesso: true, aplicado });
	}

	// ===== RICH PRESENCE =====
	if (req.method === 'GET' && url === '/api/rpc') {
		const cfg = obterConfig();
		let logo = null;
		try {
			logo = await require('./rpc').obterLogo();
		} catch {}
		return jsonResponse(res, 200, {
			sucesso: true,
			desativar_rpc: !!cfg.desativar_rpc,
			rpc: cfg.rpc || {},
			logo,
			conectado: !!ctx.cliente?.user,
			conta: ctx.cliente?.user
				? { tag: ctx.cliente.user.tag, avatar: ctx.cliente.user.displayAvatarURL?.({ size: 128 }) || null }
				: null
		});
	}
	if (req.method === 'POST' && url === '/api/rpc') {
		// App desktop local: cada instalação tem seu próprio config.json, então o
		// dono logado pode configurar o RP. Só o painel hospedado exige admin.
		if (!MODO_LOCAL && !sessao.isAdmin)
			return jsonResponse(res, 403, { sucesso: false, mensagem: 'Apenas admin pode mudar o Rich Presence' });
		const body = await lerJsonBody(req);
		const atual = obterConfig().rpc || {};
		const str = (v, def, max) => String(v != null ? v : def || '').slice(0, max || 256);
		const botoes = Array.isArray(body.botoes)
			? body.botoes
					.map((b) => ({ label: str(b && b.label, '', 64), url: str(b && b.url, '', 512) }))
					.filter((b) => b.label && b.url && URL.canParse(b.url))
					.slice(0, 2)
			: atual.botoes || [];
		const novoRpc = {
			id_aplicacao: str(body.id_aplicacao, atual.id_aplicacao, 32),
			nome: str(body.nome, atual.nome, 128),
			tipo: [0, 2, 3, 5].includes(Number(body.tipo)) ? Number(body.tipo) : Number(atual.tipo) || 0,
			detalhe: str(body.detalhe, atual.detalhe, 128),
			estado: str(body.estado, atual.estado, 128),
			url_imagem: str(body.url_imagem, atual.url_imagem, 512),
			texto_imagem: str(body.texto_imagem, atual.texto_imagem, 128),
			url_imagem_pequena: str(body.url_imagem_pequena, atual.url_imagem_pequena, 512),
			texto_imagem_pequena: str(body.texto_imagem_pequena, atual.texto_imagem_pequena, 128),
			mostrar_tempo: body.mostrar_tempo != null ? !!body.mostrar_tempo : atual.mostrar_tempo !== false,
			botoes
		};
		atualizarConfig('rpc', novoRpc);
		if (body.desativar_rpc != null) atualizarConfig('desativar_rpc', !!body.desativar_rpc);
		try {
			const rpcMod = require('./rpc');
			rpcMod.limparCacheImagens();
			if (obterConfig().desativar_rpc) rpcMod.desconectarRPC().catch(() => {});
			else rpcMod.reaplicarPresenca().catch(() => {});
		} catch {}
		return jsonResponse(res, 200, {
			sucesso: true,
			rpc: novoRpc,
			desativar_rpc: !!obterConfig().desativar_rpc,
			conectado: !!ctx.cliente?.user
		});
	}

	// ===== SNIPER DE USERNAMES =====
	// Testa nomes livres no pomelo-attempt usando os tokens salvos do usuário.
	// Não precisa do cliente conectado ao gateway (usa o token bruto).
	if (url.startsWith('/api/sniper')) {
		const sniper = require('./sniper');
		if (req.method === 'GET' && url === '/api/sniper') {
			const { listarTokensComValor } = require('./user-context');
			const salvos = await listarTokensComValor(sessao.email);
			return jsonResponse(res, 200, {
				sucesso: true,
				...sniper.snapshot(),
				tokensDisponiveis: salvos.map((t) => ({ nome: t.nome || '(sem nome)' }))
			});
		}
		if (req.method === 'POST' && url === '/api/sniper/start') {
			const body = await lerJsonBody(req);
			const { listarTokensComValor } = require('./user-context');
			const salvos = await listarTokensComValor(sessao.email);
			// Escolha: 'todos' | nome de um token salvo | token colado na hora.
			let usar = [];
			if (body.token) {
				usar = [{ token: String(body.token).trim(), nome: 'colado' }];
			} else if (body.tokenNome === '__todos__' || body.todos) {
				usar = salvos.map((t) => ({ token: t.token, nome: t.nome }));
			} else if (body.tokenNome) {
				const achou = salvos.find((t) => (t.nome || '') === body.tokenNome);
				if (achou) usar = [{ token: achou.token, nome: achou.nome }];
			}
			if (!usar.length) return jsonResponse(res, 400, { sucesso: false, mensagem: 'Escolha um token válido.' });
			const palavras = Array.isArray(body.palavras)
				? body.palavras.map((p) => String(p).trim().toLowerCase()).filter(Boolean).slice(0, 5000)
				: null;
			const r = sniper.iniciar({ modo: body.modo, tokens: usar, palavras });
			if (!r.sucesso) return jsonResponse(res, 400, r);
			return jsonResponse(res, 200, { sucesso: true, ...sniper.snapshot() });
		}
		if (req.method === 'POST' && url === '/api/sniper/stop') {
			sniper.parar();
			return jsonResponse(res, 200, { sucesso: true, ...sniper.snapshot() });
		}
		if (req.method === 'POST' && url === '/api/sniper/limpar') {
			sniper.limparEncontrados();
			return jsonResponse(res, 200, { sucesso: true, ...sniper.snapshot() });
		}
		return jsonResponse(res, 404, { sucesso: false, mensagem: 'Endpoint sniper inexistente' });
	}

	// ===== CONVIDAR AMIGOS (group DMs) =====
	// Mass-DM é sensível — no painel hospedado só admin usa; no app local o dono
	// é o único usuário, então liberamos.
	if (url.startsWith('/api/convites/')) {
		if (!MODO_LOCAL && !sessao.isAdmin) {
			return jsonResponse(res, 403, { sucesso: false, mensagem: 'Apenas admin pode usar esta função.' });
		}
		const { previewConvites, enviarConvitesWeb, admrsEntreAmigos } = require('./convites');
		if (req.method === 'POST' && url === '/api/convites/admins') {
			const r = await admrsEntreAmigos(ctx, await lerJsonBody(req));
			return jsonResponse(res, r.sucesso ? 200 : 400, r);
		}
		// Mensagens salvas (persistem em config.json). Não exigem cliente conectado.
		if (req.method === 'GET' && url === '/api/convites/mensagens') {
			const salvas = obterConfig().convites_mensagens;
			return jsonResponse(res, 200, {
				sucesso: true,
				mensagens: Array.isArray(salvas) ? salvas : null
			});
		}
		if (req.method === 'POST' && url === '/api/convites/mensagens') {
			const body = await lerJsonBody(req);
			const mensagens = (Array.isArray(body.mensagens) ? body.mensagens : [])
				.map((m) => String(m || '').trim())
				.filter(Boolean)
				.slice(0, 50)
				.map((m) => m.slice(0, 2000));
			atualizarConfig('convites_mensagens', mensagens);
			return jsonResponse(res, 200, { sucesso: true, total: mensagens.length });
		}
		if (req.method === 'POST' && url === '/api/convites/preview') {
			const r = await previewConvites(ctx, await lerJsonBody(req));
			return jsonResponse(res, r.sucesso ? 200 : 400, r);
		}
		if (req.method === 'POST' && url === '/api/convites/enviar') {
			const r = await enviarConvitesWeb(ctx, await lerJsonBody(req));
			return jsonResponse(res, r.sucesso ? 200 : 400, r);
		}
	}

	return jsonResponse(res, 404, { sucesso: false, mensagem: 'Endpoint inexistente' });
}

async function handleRequest(req, res) {
	const url = req.url.split('?')[0];
	// Medição de timing (opt-in): com PKT_TIMING=1, loga só requests que passam
	// do limite (padrão 500ms), pra achar o gargalo em produção sem inundar o
	// stdout — logging síncrono em excesso é justamente o que trava o painel.
	if (process.env.PKT_TIMING === '1') {
		const inicio = Date.now();
		res.once('finish', () => {
			const ms = Date.now() - inicio;
			const limite = Number(process.env.PKT_TIMING_MIN_MS) || 500;
			if (ms >= limite) console.log(`[timing] ${req.method} ${url} ${res.statusCode} ${ms}ms`);
		});
	}
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
	if (req.method === 'GET' && url === '/backup') {
		const sessao = await resolverSessao(req);
		if (!sessao || sessao.precisa2fa) {
			res.writeHead(302, { Location: '/login', ...headersSeguranca() });
			res.end();
			return;
		}
		fs.readFile(path.join(__dirname, '..', 'ui', 'backup-conta.html'), (err, data) => {
			if (err) {
				res.writeHead(500, { 'Content-Type': 'text/plain', ...headersSeguranca() });
				res.end('Erro ao carregar página');
				return;
			}
			enviarComprimido(req, res, 200, 'text/html; charset=utf-8', data);
		});
		return;
	}
	if (req.method === 'GET' && url === '/convites') {
		const sessao = await resolverSessao(req);
		if (!sessao || sessao.precisa2fa) {
			res.writeHead(302, { Location: '/login', ...headersSeguranca() });
			res.end();
			return;
		}
		fs.readFile(path.join(__dirname, '..', 'ui', 'convites.html'), (err, data) => {
			if (err) {
				res.writeHead(500, { 'Content-Type': 'text/plain', ...headersSeguranca() });
				res.end('Erro ao carregar página');
				return;
			}
			enviarComprimido(req, res, 200, 'text/html; charset=utf-8', data);
		});
		return;
	}
	if (req.method === 'GET' && url === '/sniper') {
		const sessao = await resolverSessao(req);
		if (!sessao || sessao.precisa2fa) {
			res.writeHead(302, { Location: '/login', ...headersSeguranca() });
			res.end();
			return;
		}
		fs.readFile(path.join(__dirname, '..', 'ui', 'sniper.html'), (err, data) => {
			if (err) {
				res.writeHead(500, { 'Content-Type': 'text/plain', ...headersSeguranca() });
				res.end('Erro ao carregar página');
				return;
			}
			enviarComprimido(req, res, 200, 'text/html; charset=utf-8', data);
		});
		return;
	}
	if (req.method === 'GET' && url === '/rpc') {
		const sessao = await resolverSessao(req);
		if (!sessao || sessao.precisa2fa) {
			res.writeHead(302, { Location: '/login', ...headersSeguranca() });
			res.end();
			return;
		}
		fs.readFile(path.join(__dirname, '..', 'ui', 'rpc-config.html'), (err, data) => {
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
			if (err) {
				res.writeHead(500, { 'Content-Type': 'text/plain', ...headersSeguranca() });
				res.end('Erro');
				return;
			}
			// App local: login SÓ pelo Discord — esconde o acesso por e-mail/senha
			// (a rota /api/auth/site/login também é bloqueada, não é só cosmético).
			if (MODO_LOCAL_AUTH && arquivo === 'login.html') {
				data = Buffer.from(
					String(data).replace(
						'</head>',
						'<style>#toggle-admin, #form-senha { display: none !important; }</style></head>'
					)
				);
			}
			enviarComprimido(req, res, 200, 'text/html; charset=utf-8', data);
		});
		return;
	}
	if (req.method === 'GET' && url === '/ui/vendor/qrcode.min.js') {
		fs.readFile(path.join(__dirname, '..', 'ui', 'vendor', 'qrcode.min.js'), (err, data) => {
			if (err) {
				res.writeHead(404, { 'Content-Type': 'text/plain', ...headersSeguranca() });
				res.end('Not found');
				return;
			}
			res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', ...headersSeguranca() });
			res.end(data);
		});
		return;
	}
	if (req.method === 'GET' && /^\/ui\/assets\/[a-zA-Z0-9_-]+\.svg$/.test(url)) {
		const nome = url.substring('/ui/assets/'.length);
		fs.readFile(path.join(__dirname, '..', 'ui', 'assets', nome), (err, data) => {
			if (err) {
				res.writeHead(404, { 'Content-Type': 'text/plain', ...headersSeguranca() });
				res.end('Not found');
				return;
			}
			res.writeHead(200, {
				'Content-Type': 'image/svg+xml; charset=utf-8',
				'Cache-Control': 'public, max-age=86400',
				...headersSeguranca()
			});
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
		const ui = carregarUI();
		if (!ui) {
			res.writeHead(500, { 'Content-Type': 'text/plain', ...headersSeguranca() });
			res.end('Erro ao carregar UI');
			return;
		}
		const cacheHeaders = { ETag: ui.etag, 'Cache-Control': 'private, no-cache' };
		// Revalidação condicional: se o browser já tem a versão atual, 304 sem corpo.
		if ((req.headers['if-none-match'] || '') === ui.etag) {
			res.writeHead(304, { ...headersSeguranca(), ...cacheHeaders });
			res.end();
			return;
		}
		const aceitaGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
		const baseHeaders = { 'Content-Type': 'text/html; charset=utf-8', ...headersSeguranca(), ...cacheHeaders };
		if (aceitaGzip) {
			res.writeHead(200, { ...baseHeaders, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
			res.end(ui.gz);
		} else {
			res.writeHead(200, baseHeaders);
			res.end(ui.raw);
		}
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
	// Garante que existe admin. No modo local SEM login não criamos conta (não há
	// login). Já no modo local COM login (PKTHEGOAT_AUTH), a conta admin PRECISA
	// existir pro Discord super-admin (SUPERADMIN_DISCORD_ID) se vincular a ela —
	// senão o super-admin logaria como usuário comum.
	const credInicial = MODO_LOCAL && !MODO_LOCAL_AUTH ? null : await inicializarAdminSeNecessario();
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

	// Pré-aquece o cache da UI (buffer + gzip) pra 1ª request já sair pronta.
	try {
		carregarUI();
	} catch {}

	return new Promise((resolve, reject) => {
		tentarPorta(
			PORTA_INICIAL,
			({ porta }) => {
				resolve({ porta, url: `http://${HOST}:${porta}`, jaEstavaAtivo: false });
			},
			reject
		);
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
