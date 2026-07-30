/**
 * Convidar amigos para um servidor via GROUP DMs.
 *
 * Fluxo: pega a lista de amigos da conta logada, descobre quais NÃO estão no
 * servidor escolhido, agrupa esses amigos em group DMs de até 9 (10 no total
 * com você) e manda uma mensagem-convite em cada grupo. As mensagens são
 * sorteadas aleatoriamente de um pool (sem repetir a anterior) e há um atraso
 * aleatório entre cada grupo — pra não cair no padrão de spam do Discord.
 *
 * Roda como background task do contexto do usuário, com progresso — igual às
 * demais ações do painel (ver web-actions.js).
 */

const { sleep } = require('../utils/sleep');
const { listarRelacionamentos } = require('./discord');

const RELATIONSHIP_FRIEND = 1;
const MAX_GRUPO = 9; // group DM = 10 membros no total (você + 9)
const FETCH_CHUNK = 100; // op-8 (request guild members) aceita até 100 ids por vez

function progressoBase(fase, total = 0) {
	return { fase, atual: 0, total, erros: 0, enviados: 0, iniciadoEm: Date.now() };
}

function atualizarProgresso(tasks, taskId, patch) {
	const task = tasks.getTask(taskId);
	if (!task) return;
	task.data.progress = { ...(task.data.progress || {}), ...patch };
}

function chunk(arr, tamanho) {
	const out = [];
	for (let i = 0; i < arr.length; i += tamanho) out.push(arr.slice(i, i + tamanho));
	return out;
}

// Sorteia uma mensagem do pool evitando repetir a imediatamente anterior.
function sortearMensagem(pool, ultima) {
	if (pool.length === 1) return pool[0];
	let m;
	do {
		m = pool[Math.floor(Math.random() * pool.length)];
	} while (m === ultima);
	return m;
}

// Quando a amizade começou (ms epoch) ou null se o Discord não mandou a data.
// A lib guarda isso em relationships.sinceCache (Date); amizades sem data vêm
// como new Date(0), que tratamos como desconhecida.
function amizadeDesde(cliente, id) {
	try {
		const d = cliente.relationships?.sinceCache?.get(id);
		const ms = d instanceof Date ? d.getTime() : Number(d) || 0;
		return ms > 0 ? ms : null;
	} catch {
		return null;
	}
}

function infoAmigo(cliente, id) {
	const u = cliente.users?.cache?.get(id) || cliente.relationships?.friendCache?.get(id)?.user || null;
	return {
		id,
		tag: u?.tag || u?.globalName || u?.username || id,
		avatar: u?.displayAvatarURL?.({ size: 64 }) || null,
		desde: amizadeDesde(cliente, id)
	};
}

// Descobre quais amigos NÃO estão no servidor. Confere primeiro o cache de
// membros e, pros que faltam, faz fetch por lotes de IDs (op-8). Quem não voltar
// do fetch é porque não está no servidor.
async function amigosForaDoGuild(cliente, guild, friendIds) {
	const dentro = new Set();
	const faltando = [];
	for (const id of friendIds) {
		if (guild.members.cache.has(id)) dentro.add(id);
		else faltando.push(id);
	}
	for (const lote of chunk(faltando, FETCH_CHUNK)) {
		try {
			const encontrados = await guild.members.fetch({ user: lote, time: 20000 });
			for (const id of encontrados.keys()) dentro.add(id);
		} catch {
			// Falha no lote (timeout/rate-limit): assume que não estão dentro. Como
			// o objetivo é convidar quem está fora, no pior caso convida alguém que
			// já entrou — inofensivo comparado a não convidar ninguém.
		}
		await sleep(1);
	}
	return friendIds.filter((id) => !dentro.has(id));
}

// Permissões que indicam staff/moderação. Quem tiver qualquer uma é tratado como
// "admin" pra fins de exclusão (evita divulgar pra staff e tomar ban).
const STAFF_PERMS = [
	'ADMINISTRATOR',
	'MANAGE_GUILD',
	'BAN_MEMBERS',
	'KICK_MEMBERS',
	'MODERATE_MEMBERS',
	'MUTE_MEMBERS', // pode te mutar em call
	'DEAFEN_MEMBERS' // pode te ensurdecer em call
];
const ROTULO_PERM = {
	MANAGE_GUILD: 'gerenciar servidor',
	BAN_MEMBERS: 'banir',
	KICK_MEMBERS: 'expulsar',
	MODERATE_MEMBERS: 'moderar (timeout)',
	MUTE_MEMBERS: 'mutar em call',
	DEAFEN_MEMBERS: 'ensurdecer em call'
};
// Heurística por NOME de cargo (pega staff que não tem a permissão setada no cargo).
const NOME_STAFF = /admin|moderad|\bmod\b|staff|equipe|dono|owner|gerente|manager|helper|suporte/i;

function temPerm(membro, perm) {
	try {
		return !!membro.permissions?.has?.(perm);
	} catch {
		return false;
	}
}

// Entre os IDs informados, descobre quais são admin/staff no servidor escolhido.
// Retorna [{ id, tag, motivo }]. Usado pra desmarcar essas pessoas antes do envio.
async function admrsEntreAmigos(ctx, opts = {}) {
	const cliente = ctx.cliente;
	const guildId = String(opts.guildId || '').trim();
	if (!guildId) return { sucesso: false, mensagem: 'Selecione o servidor para checar admins.' };
	const guild = cliente.guilds.cache.get(guildId);
	if (!guild) return { sucesso: false, mensagem: 'Servidor inválido ou a conta não está nele.' };

	let ids = Array.isArray(opts.ids) && opts.ids.length
		? opts.ids.map((x) => String(x))
		: listarRelacionamentos(cliente, RELATIONSHIP_FRIEND);
	ids = [...new Set(ids)];
	if (!ids.length) return { sucesso: false, mensagem: 'Nenhum usuário para checar.' };

	// Resolve os membros no servidor (cache + fetch por lotes). Quem não está no
	// servidor simplesmente não é staff lá — ignorado.
	const membros = new Map();
	const faltando = [];
	for (const id of ids) {
		const m = guild.members.cache.get(id);
		if (m) membros.set(id, m);
		else faltando.push(id);
	}
	for (const lote of chunk(faltando, FETCH_CHUNK)) {
		try {
			const fetched = await guild.members.fetch({ user: lote, time: 20000 });
			for (const [id, m] of fetched) membros.set(id, m);
		} catch {}
		await sleep(1);
	}

	const admins = [];
	for (const [id, m] of membros) {
		let motivo = null;
		if (id === guild.ownerId) motivo = 'dono do servidor';
		else if (temPerm(m, 'ADMINISTRATOR')) motivo = 'administrador';
		else {
			const perm = STAFF_PERMS.find((p) => temPerm(m, p));
			if (perm) motivo = 'permissão: ' + (ROTULO_PERM[perm] || perm);
		}
		if (!motivo) {
			const cargo = m.roles?.cache?.find((r) => NOME_STAFF.test(r.name));
			if (cargo) motivo = 'cargo: ' + cargo.name;
		}
		if (motivo) admins.push({ id, tag: m.user?.tag || m.user?.username || id, motivo });
	}
	return { sucesso: true, servidor: guild.name, checados: membros.size, admins };
}

// Só a análise: quantos amigos estão fora do servidor (pra prévia na UI, sem enviar nada).
async function previewConvites(ctx, opts = {}) {
	const cliente = ctx.cliente;
	const guildId = String(opts.guildId || '').trim();
	if (!guildId) return { sucesso: false, mensagem: 'Selecione um servidor.' };
	const guild = cliente.guilds.cache.get(guildId);
	if (!guild) return { sucesso: false, mensagem: 'Servidor inválido ou a conta não está nele.' };

	const friendIds = listarRelacionamentos(cliente, RELATIONSHIP_FRIEND);
	if (friendIds.length === 0) return { sucesso: false, mensagem: 'Você não tem amigos.' };

	const fora = await amigosForaDoGuild(cliente, guild, friendIds);
	const amigos = fora.map((id) => infoAmigo(cliente, id)).sort((a, b) => String(a.tag).localeCompare(String(b.tag)));
	return {
		sucesso: true,
		servidor: guild.name,
		totalAmigos: friendIds.length,
		fora: amigos.length,
		grupos: Math.ceil(amigos.length / MAX_GRUPO),
		// Quantos têm data de amizade conhecida — a UI usa pra avisar caso o
		// filtro "adicionados recentemente" não tenha dados pra trabalhar.
		comData: amigos.filter((a) => a.desde).length,
		amigos
	};
}

// Dispara os convites em background. opts:
//   { guildId, mensagens: string[], tamanhoGrupo?, delayMin?, delayMax? }
async function enviarConvitesWeb(ctx, opts = {}) {
	const cliente = ctx.cliente;
	const guildId = String(opts.guildId || '').trim();
	if (!guildId) return { sucesso: false, mensagem: 'Selecione um servidor.' };
	const guild = cliente.guilds.cache.get(guildId);
	if (!guild) return { sucesso: false, mensagem: 'Servidor inválido ou a conta não está nele.' };

	const mensagens = (Array.isArray(opts.mensagens) ? opts.mensagens : [])
		.map((m) => String(m || '').trim())
		.filter(Boolean)
		.slice(0, 20);
	if (mensagens.length === 0) return { sucesso: false, mensagem: 'Escreva ao menos uma mensagem.' };

	// Modo 'individual' = DM direta 1 a 1 (grupo de tamanho 1); 'grupo' = group DM.
	const modo = String(opts.modo || 'grupo').toLowerCase() === 'individual' ? 'individual' : 'grupo';
	const tamanhoGrupo = modo === 'individual' ? 1 : Math.min(MAX_GRUPO, Math.max(1, Number(opts.tamanhoGrupo) || MAX_GRUPO));
	const delayMin = Math.max(1, Number(opts.delayMin) || 60);
	const delayMax = Math.max(delayMin, Number(opts.delayMax) || 60);

	const friendIds = listarRelacionamentos(cliente, RELATIONSHIP_FRIEND);
	if (friendIds.length === 0) return { sucesso: false, mensagem: 'Você não tem amigos.' };

	const fora = await amigosForaDoGuild(cliente, guild, friendIds);
	if (fora.length === 0) {
		return { sucesso: false, mensagem: 'Todos os seus amigos já estão nesse servidor.' };
	}

	// Filtro opcional: se a UI mandar `incluir` (IDs marcados), só convida esses —
	// sempre dentro do conjunto que está de fato fora do servidor (segurança).
	const incluir = Array.isArray(opts.incluir) && opts.incluir.length
		? new Set(opts.incluir.map((x) => String(x)))
		: null;
	const alvo = incluir ? fora.filter((id) => incluir.has(id)) : fora;
	if (alvo.length === 0) {
		return { sucesso: false, mensagem: 'Nenhum amigo selecionado (ou os selecionados já entraram no servidor).' };
	}

	const grupos = chunk(alvo, tamanhoGrupo);

	let cancelado = false;
	const stop = async () => {
		cancelado = true;
	};
	const taskId = ctx.tasks.addTask(`Convidando amigos: ${guild.name}`, stop, {
		servidor: guild.name,
		progress: progressoBase('enviando', grupos.length)
	});

	// Rate limit: a lib segura o request sozinha (não lança erro) e emite 'rateLimit'.
	// Contamos e registramos o último pra mostrar na tela — é o sinal de que você
	// está indo rápido demais. `global`/`timeout` alto = sinal sério.
	let ratelimits = 0;
	let ratelimitGlobal = 0;
	const onRateLimit = (info) => {
		ratelimits++;
		if (info && info.global) ratelimitGlobal++;
		atualizarProgresso(ctx.tasks, taskId, {
			ratelimits,
			ratelimitGlobal,
			ultimoRatelimit: {
				em: Date.now(),
				timeout: info?.timeout || 0,
				route: info?.route || info?.path || '',
				method: info?.method || '',
				global: !!(info && info.global)
			}
		});
	};
	cliente.on('rateLimit', onRateLimit);

	(async () => {
		let ok = 0; // grupos enviados
		let enviados = 0; // amigos alcançados
		let erros = 0;
		let ultimaMsg = null;
		try {
			for (let i = 0; i < grupos.length; i++) {
				if (cancelado) break;
				const recipients = grupos[i];
				const mensagem = sortearMensagem(mensagens, ultimaMsg);
				ultimaMsg = mensagem;
				try {
					// Cria a group DM (raw API). Com >1 recipient vira grupo; com 1 vira DM normal.
					const canal = await cliente.api.users(cliente.user.id).channels.post({
						data: { recipients }
					});
					// Pequeno respiro entre criar o grupo e mandar a mensagem.
					await sleep(1 + Math.random() * 2);
					if (cancelado) break;
					await cliente.api.channels(canal.id).messages.post({
						data: { content: mensagem }
					});
					ok++;
					enviados += recipients.length;
				} catch (e) {
					erros++;
					const msg = e?.message || String(e);
					const status = e?.httpStatus || e?.status || e?.code;
					let tipo = null;
					if (status === 429 || /rate ?limit|being blocked/i.test(msg)) tipo = 'ratelimit';
					else if (/captcha/i.test(msg)) tipo = 'captcha'; // conta sinalizada
					atualizarProgresso(ctx.tasks, taskId, { ultimoErro: msg, ultimoErroTipo: tipo });
						if (tipo === 'captcha') { cancelado = true; atualizarProgresso(ctx.tasks, taskId, { fase: 'captcha-parado' }); }
				}
				atualizarProgresso(ctx.tasks, taskId, { atual: ok, enviados, erros });
				// Atraso aleatório entre grupos (anti-spam).
				if (cancelado) break;
					if (i < grupos.length - 1) {
					await sleep(delayMin + Math.random() * (delayMax - delayMin));
				}
			}
		} finally {
			try {
				cliente.off('rateLimit', onRateLimit);
			} catch {}
			atualizarProgresso(ctx.tasks, taskId, { fase: 'concluido', atual: ok, enviados, erros });
			setTimeout(() => ctx.tasks.removeTask(taskId).catch(() => {}), 4000);
		}
	})();

	return { sucesso: true, taskId, modo, grupos: grupos.length, fora: alvo.length, alcance: alvo.length };
}

module.exports = { previewConvites, enviarConvitesWeb, admrsEntreAmigos };
