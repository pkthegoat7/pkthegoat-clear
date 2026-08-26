/**
 * Sniper de usernames do Discord.
 *
 * Fica testando nomes no endpoint /users/@me/pomelo-attempt (o mesmo que o
 * Discord usa pra dizer se um @username está livre) usando um ou mais tokens
 * de conta, respeitando o rate limit de cada token. Os nomes disponíveis são
 * guardados em memória e persistidos em data/sniper-encontrados.json.
 *
 * Roda em background no processo do backend (start/stop via API). Só um sniper
 * roda por vez.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./auth');

const ARQUIVO = path.join(dataDir(), 'sniper-encontrados.json');

// Intervalo por token (ms). O Discord dá rate limit fácil nesse endpoint,
// então mantemos folgado. Com N tokens o intervalo efetivo é DELAY_MS / N.
const DELAY_MS = 20000;

const CARACTERES = 'abcdefghijklmnopqrstuvwxyz0123456789';

// Wordlist padrão (usada no modo "palavras" quando não há lista custom).
const WORDLIST_PADRAO = [
	'shadow', 'ghost', 'sniper', 'ninja', 'dragon', 'venom', 'storm', 'blaze',
	'frost', 'raven', 'wolf', 'tiger', 'cyber', 'pixel', 'neon', 'toxic',
	'rogue', 'flux', 'echo', 'void', 'zenith', 'nova', 'hydra', 'phantom',
	'vortex', 'reaper', 'chaos', 'onyx', 'quartz', 'lunar', 'ember', 'saint',
	'omen', 'crypt', 'grim', 'halo', 'jinx', 'karma', 'lynx', 'mist'
];

let estado = {
	rodando: false,
	modo: '4', // '4' = 4 caracteres | 'palavras'
	status: 'parado', // parado | rodando | rate_limit | sem_token
	checados: 0,
	ultimo: null,
	iniciadoEm: null,
	encontrados: carregarEncontrados()
};

let tokens = []; // [{ token, nome, bloqueadoAte }]
let idx = 0;
let timer = null;
let palavras = WORDLIST_PADRAO;

function carregarEncontrados() {
	try {
		if (fs.existsSync(ARQUIVO)) {
			const lista = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
			if (Array.isArray(lista)) return lista;
		}
	} catch {}
	return [];
}

function salvarEncontrados() {
	try {
		fs.writeFileSync(ARQUIVO, JSON.stringify(estado.encontrados, null, 2));
	} catch (e) {
		console.error('[sniper] erro ao salvar encontrados:', e.message);
	}
}

function gerarNome() {
	if (estado.modo === 'palavras') {
		return palavras[Math.floor(Math.random() * palavras.length)];
	}
	let s = '';
	for (let i = 0; i < 4; i++) s += CARACTERES[Math.floor(Math.random() * CARACTERES.length)];
	return s;
}

// POST no pomelo-attempt. Resolve com { status, dados }.
function tentar(token, nome) {
	return new Promise((resolve) => {
		const payload = JSON.stringify({ username: nome });
		const req = https.request(
			{
				method: 'POST',
				hostname: 'discord.com',
				path: '/api/v9/users/@me/pomelo-attempt',
				headers: {
					Authorization: token,
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload)
				}
			},
			(res) => {
				let body = '';
				res.on('data', (c) => (body += c));
				res.on('end', () => {
					let dados = {};
					try {
						dados = JSON.parse(body || '{}');
					} catch {}
					resolve({ status: res.statusCode, dados });
				});
			}
		);
		req.on('error', () => resolve({ status: 0, dados: {} }));
		req.write(payload);
		req.end();
	});
}

function tokenDisponivel() {
	const agora = Date.now();
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[idx % tokens.length];
		idx++;
		if (agora >= (t.bloqueadoAte || 0)) return t;
	}
	return null; // todos em rate limit
}

async function tick() {
	if (!estado.rodando) return;

	const t = tokenDisponivel();
	if (!t) {
		estado.status = 'rate_limit';
		const espera = Math.min(...tokens.map((x) => x.bloqueadoAte || 0)) - Date.now();
		return agendar(Math.max(1000, espera));
	}

	const nome = gerarNome();
	const { status, dados } = await tentar(t.token, nome);
	estado.checados++;
	estado.ultimo = { nome, status, em: Date.now() };
	estado.status = 'rodando';

	if (status === 200 && dados.taken === false) {
		if (!estado.encontrados.some((e) => e.nome === nome)) {
			estado.encontrados.unshift({ nome, em: Date.now(), porToken: t.nome || null });
			estado.encontrados = estado.encontrados.slice(0, 500);
			salvarEncontrados();
		}
	} else if (status === 429) {
		const retry = Number(dados.retry_after) || 60;
		t.bloqueadoAte = Date.now() + retry * 1000;
	} else if (status === 401 || status === 403) {
		t.bloqueadoAte = Date.now() + 24 * 60 * 60 * 1000; // token ruim: some por 24h
		estado.ultimo.tokenInvalido = t.nome || '...' + t.token.slice(-6);
	}

	const intervalo = Math.max(1000, Math.round(DELAY_MS / Math.max(1, tokens.length)));
	agendar(intervalo);
}

function agendar(ms) {
	clearTimeout(timer);
	if (!estado.rodando) return;
	timer = setTimeout(tick, ms);
}

/**
 * Inicia o sniper.
 * @param {{ modo?: string, tokens: {token:string,nome?:string}[], palavras?: string[] }} opts
 */
function iniciar(opts = {}) {
	const lista = (opts.tokens || []).filter((t) => t && t.token);
	if (!lista.length) return { sucesso: false, mensagem: 'Nenhum token informado' };

	parar();
	tokens = lista.map((t) => ({ token: t.token, nome: t.nome || null, bloqueadoAte: 0 }));
	idx = 0;
	estado.modo = opts.modo === 'palavras' ? 'palavras' : '4';
	palavras = Array.isArray(opts.palavras) && opts.palavras.length ? opts.palavras : WORDLIST_PADRAO;
	estado.rodando = true;
	estado.status = 'rodando';
	estado.checados = 0;
	estado.ultimo = null;
	estado.iniciadoEm = Date.now();
	agendar(500);
	return { sucesso: true };
}

function parar() {
	estado.rodando = false;
	estado.status = 'parado';
	clearTimeout(timer);
	timer = null;
	return { sucesso: true };
}

function limparEncontrados() {
	estado.encontrados = [];
	salvarEncontrados();
	return { sucesso: true };
}

function snapshot() {
	return {
		rodando: estado.rodando,
		modo: estado.modo,
		status: estado.status,
		checados: estado.checados,
		ultimo: estado.ultimo,
		iniciadoEm: estado.iniciadoEm,
		numTokens: tokens.length,
		encontrados: estado.encontrados
	};
}

module.exports = { iniciar, parar, snapshot, limparEncontrados };
