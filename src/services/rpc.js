// Rich Presence via GATEWAY (self). Aplica a atividade na conta selfbot
// conectada (ctx.cliente) usando a classe RichPresence do discord.js-selfbot-v13.
// Diferente do antigo discord-rpc por IPC, NÃO depende do Discord desktop aberto
// e todos veem a presença — inclusive nome e tipo livres.
const { RichPresence } = require('discord.js-selfbot-v13');
const { obterConfig } = require('../config/configuracao');
const { version } = require('../../package.json');

const APP_ID_PADRAO = '1441501260984356907';
// Tipos suportados na UI (Streaming exige URL de twitch/youtube, então fica fora).
const TIPOS_VALIDOS = new Set([0, 2, 3, 5]);

// O gateway limita updates de presença (op 3) a poucos por dezena de segundos.
// Como várias features chamam atualizarPresenca() em sequência (backup/clonar/etc),
// coalescemos os envios: guardamos o último override e mandamos no máximo 1 a cada
// MIN_INTERVALO_MS, sempre com o estado mais recente.
const MIN_INTERVALO_MS = 12000;

let inicioTimestamp = null; // base do "tempo decorrido" — fixa entre updates
let ultimoEnvio = 0;
let timer = null;
const cacheExterno = new Map(); // url original -> external/{hash} (proxy do Discord)

/**
 * Lista os clients principais (self) atualmente conectados no gateway.
 */
function listarClientes() {
	try {
		const { clientesConectados } = require('./user-context');
		return clientesConectados() || [];
	} catch {
		return [];
	}
}

/**
 * Normaliza os botões (até 2) aceitando o formato novo (botoes:[{label,url}]) e
 * o legado (texto_botao/url_botao). Filtra os inválidos pra não estourar setButtons.
 */
function normalizarBotoes(rpc) {
	let lista = [];
	if (Array.isArray(rpc.botoes)) lista = rpc.botoes;
	else if (rpc.texto_botao && rpc.url_botao) lista = [{ label: rpc.texto_botao, url: rpc.url_botao }];
	return lista
		.map((b) => ({ name: String(b.label || b.name || '').trim(), url: String(b.url || '').trim() }))
		.filter((b) => b.name && b.url && URL.canParse(b.url))
		.slice(0, 2);
}

/**
 * Resolve uma imagem pro formato que o RichPresence aceita. URLs do CDN do Discord
 * e asset-ids passam direto; qualquer outra URL externa (imgur, etc.) é convertida
 * em proxy (external/{hash}) via API do Discord e cacheada.
 */
async function resolverImagem(client, appId, url) {
	url = String(url || '').trim();
	if (!url) return null;
	if (/^[0-9]{17,19}$/.test(url)) return url; // asset id
	if (/^(mp|spotify|youtube|twitch):/.test(url) || url.startsWith('external/')) return url;
	if (/(cdn\.discordapp\.com|media\.discordapp\.net)/.test(url)) return url; // parseImage vira mp:
	if (!/^https?:\/\//i.test(url)) return null;
	if (cacheExterno.has(url)) return cacheExterno.get(url);
	try {
		const res = await RichPresence.getExternal(client, appId || APP_ID_PADRAO, url);
		const caminho = res && res[0] && res[0].external_asset_path;
		if (caminho) {
			cacheExterno.set(url, caminho);
			return caminho;
		}
	} catch {}
	return null;
}

/**
 * Monta o objeto RichPresence a partir da config. A presença é ESTÁVEL (o que o
 * dono configurou) — não reflete o que o bot está fazendo no momento, pra não
 * transmitir texto de operação pra todo mundo via gateway.
 */
async function construirPresenca(client, config) {
	const rpc = config.rpc || {};
	const nome = String(rpc.nome || 'pkthegoat clear').slice(0, 128);
	const tipo = Number(rpc.tipo);

	const rp = new RichPresence(client)
		.setApplicationId(rpc.id_aplicacao || APP_ID_PADRAO)
		.setName(nome)
		.setType(TIPOS_VALIDOS.has(tipo) ? tipo : 0);

	if (rpc.detalhe) rp.setDetails(String(rpc.detalhe).slice(0, 128));

	const estado = rpc.estado || `/v${version}`;
	if (estado) rp.setState(String(estado).slice(0, 128));

	if (rpc.mostrar_tempo) {
		if (!inicioTimestamp) inicioTimestamp = Date.now();
		rp.setStartTimestamp(inicioTimestamp);
	}

	const grande = await resolverImagem(client, rpc.id_aplicacao, rpc.url_imagem);
	if (grande) {
		rp.setAssetsLargeImage(grande);
		const txt = rpc.texto_imagem || nome;
		if (txt) rp.setAssetsLargeText(String(txt).slice(0, 128));
	}

	const pequena = await resolverImagem(client, rpc.id_aplicacao, rpc.url_imagem_pequena);
	if (pequena) {
		rp.setAssetsSmallImage(pequena);
		if (rpc.texto_imagem_pequena) rp.setAssetsSmallText(String(rpc.texto_imagem_pequena).slice(0, 128));
	}

	const botoes = normalizarBotoes(rpc);
	if (botoes.length) rp.setButtons(...botoes);

	return rp;
}

/**
 * Aplica a presença configurada agora, em todos os clients conectados (sem passar
 * pelo throttle). Usado no boot, ao conectar uma conta e ao salvar pela UI.
 */
async function reaplicarPresenca() {
	const config = obterConfig();
	if (config.desativar_rpc) return;
	for (const client of listarClientes()) {
		if (!client || !client.user) continue;
		try {
			const rp = await construirPresenca(client, config);
			client.user.setPresence({ activities: [rp] });
		} catch (e) {
			console.error('Erro ao aplicar Rich Presence:', e.message);
		}
	}
}

async function flush() {
	timer = null;
	ultimoEnvio = Date.now();
	await reaplicarPresenca().catch(() => {});
}

// Reaplica a presença configurada, no máximo 1x a cada MIN_INTERVALO_MS. Chamado
// pelas features com frequência — serve pra "auto-curar" a presença após um
// resume/reconexão do gateway, sem transmitir o estado da operação.
function agendar() {
	if (timer) return;
	const espera = Math.max(0, MIN_INTERVALO_MS - (Date.now() - ultimoEnvio));
	timer = setTimeout(flush, espera);
	if (timer.unref) timer.unref();
}

/**
 * Habilita o RPC e aplica a presença configurada (nos clients já conectados).
 * Chamado no boot do backend.
 */
async function inicializarRPC() {
	const config = obterConfig();
	if (config.desativar_rpc) return false;
	inicioTimestamp = Date.now();
	await reaplicarPresenca().catch(() => {});
	return true;
}

/**
 * Aplica a presença configurada em UM client recém-conectado (hook do conectarToken).
 */
async function aplicarEmCliente(client) {
	const config = obterConfig();
	if (config.desativar_rpc || !client || !client.user) return;
	if (!inicioTimestamp) inicioTimestamp = Date.now();
	try {
		const rp = await construirPresenca(client, config);
		client.user.setPresence({ activities: [rp] });
	} catch (e) {
		console.error('Erro ao aplicar Rich Presence na conta:', e.message);
	}
}

/**
 * Chamada pelas features durante operações. Não transmite o estado da operação —
 * apenas reagenda uma reaplicação (throttled) da presença configurada, o que
 * mantém o RP vivo ao longo de sessões longas. Aceita e ignora argumentos.
 */
async function atualizarPresenca() {
	const config = obterConfig();
	if (config.desativar_rpc) return;
	if (!listarClientes().length) return;
	agendar();
}

/**
 * Limpa a atividade em todos os clients (ao desativar o RPC).
 */
async function desconectarRPC() {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
	for (const client of listarClientes()) {
		try {
			client.user.setActivity();
		} catch {}
	}
}

/**
 * Invalida o cache de imagens externas (ao trocar url_imagem pela UI).
 */
function limparCacheImagens() {
	cacheExterno.clear();
}

module.exports = {
	inicializarRPC,
	atualizarPresenca,
	reaplicarPresenca,
	aplicarEmCliente,
	desconectarRPC,
	limparCacheImagens
};
