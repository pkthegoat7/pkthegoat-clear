/**
 * Backup da conta (social): amigos, notas, pedidos de amizade (recebidos e
 * enviados), bloqueados, servidores e DMs/grupos. Gera um objeto JSON a partir
 * dos caches do self conectado — não altera nada na conta, só lê.
 *
 * Tipos de relacionamento (discord.js-selfbot-v13):
 *   1 FRIEND · 2 BLOCKED · 3 PENDING_INCOMING (recebido) · 4 PENDING_OUTGOING (enviado)
 * Expostos como relationships.friendCache/blockedCache/incomingCache/outgoingCache.
 */

const { sleep } = require('../utils/sleep');

const RE_ID = /^\d{15,25}$/;

// Gera 1 convite permanente por servidor (onde a conta tem permissão CREATE_INSTANT_INVITE).
// Retorna mapa guildId -> { code, url } ou { erro }. Feito em lotes com pausa
// pra não estourar rate limit. Servidores sem permissão ficam sem convite.
async function gerarConvitesServidores(cliente, onProgress) {
	const guilds = Array.from(cliente.guilds?.cache?.values() || []);
	const mapa = {};
	const LOTE = 4;
	for (let i = 0; i < guilds.length; i += LOTE) {
		const lote = guilds.slice(i, i + LOTE);
		await Promise.all(
			lote.map(async (g) => {
				try {
					const me = g.members?.me;
					const canal = g.channels?.cache?.find(
						(c) =>
							['GUILD_TEXT', 'GUILD_VOICE', 'GUILD_ANNOUNCEMENT', 'GUILD_STAGE_VOICE'].includes(c.type) &&
							c.permissionsFor?.(me)?.has?.('CREATE_INSTANT_INVITE')
					);
					if (!canal) {
						mapa[g.id] = { erro: 'sem permissão de convite' };
						return;
					}
					const inv = await canal.createInvite({ maxAge: 0, maxUses: 0, unique: false });
					mapa[g.id] = { code: inv.code, url: `https://discord.gg/${inv.code}` };
				} catch (e) {
					mapa[g.id] = { erro: e?.message || 'falhou' };
				}
			})
		);
		if (onProgress) onProgress(Math.min(i + LOTE, guilds.length), guilds.length);
		await sleep(0.6);
	}
	return mapa;
}

// Restaura (parcialmente) uma conta a partir de um backup gerado por montarBackupConta.
// SÓ dá pra: reenviar pedidos de amizade (amigos + enviados), recriar notas e
// reabrir DMs 1:1. Servidores e pedidos recebidos NÃO são restauráveis.
// Roda como background task com progresso + monitor de rate limit (ação sensível).
// opts: { backup, incluir:{amigos,pedidos_enviados,notas,dms}, delayMin, delayMax }
async function restaurarContaWeb(ctx, opts = {}) {
	const cliente = ctx.cliente;
	const backup = opts.backup && typeof opts.backup === 'object' ? opts.backup : null;
	if (!backup) return { sucesso: false, mensagem: 'Backup inválido ou não carregado.' };
	const inc = opts.incluir || {};
	const delayMin = Math.max(1, Number(opts.delayMin) || 6);
	const delayMax = Math.max(delayMin, Number(opts.delayMax) || 14);

	// Coleta alvos
	const idsAmigos = [];
	const pushIds = (arr) => {
		for (const x of arr || []) {
			const id = String((x && (x.id || x)) || '');
			if (RE_ID.test(id)) idsAmigos.push(id);
		}
	};
	if (inc.amigos !== false) pushIds(backup.amigos);
	if (inc.pedidos_enviados) pushIds(backup.pedidos_enviados);
	const idsUnicos = [...new Set(idsAmigos)];

	const notas =
		inc.notas !== false && Array.isArray(backup.notas)
			? backup.notas.filter((n) => n && RE_ID.test(String(n.id)) && n.nota)
			: [];
	const dms =
		inc.dms === true && Array.isArray(backup.dms)
			? backup.dms.filter((d) => d && d.tipo === 'dm' && RE_ID.test(String(d.userId))).map((d) => String(d.userId))
			: [];

	// Servidores: só dá pra re-entrar nos que têm convite salvo no backup.
	const servidores =
		inc.servidores === true && Array.isArray(backup.servidores)
			? backup.servidores.filter((s) => s && (s.convite_code || s.convite)).map((s) => s.convite_code || s.convite)
			: [];

	const total = idsUnicos.length + notas.length + dms.length + servidores.length;
	if (total === 0) return { sucesso: false, mensagem: 'Nada para restaurar (backup vazio ou seções desmarcadas).' };

	let cancelado = false;
	const stop = async () => {
		cancelado = true;
	};
	const taskId = ctx.tasks.addTask('Restaurando conta', stop, {
		progress: {
			fase: 'iniciando',
			atual: 0,
			total,
			erros: 0,
			pedidos: 0,
			notas: 0,
			dms: 0,
			servidores: 0,
			iniciadoEm: Date.now()
		}
	});
	const prog = (patch) => {
		const t = ctx.tasks.getTask(taskId);
		if (t) t.data.progress = { ...(t.data.progress || {}), ...patch };
	};

	// Monitor de rate limit (mandar muitos pedidos de amizade estoura fácil).
	let ratelimits = 0,
		ratelimitGlobal = 0;
	const onRL = (info) => {
		ratelimits++;
		if (info && info.global) ratelimitGlobal++;
		prog({
			ratelimits,
			ratelimitGlobal,
			ultimoRatelimit: { em: Date.now(), timeout: info?.timeout || 0, global: !!(info && info.global) }
		});
	};
	cliente.on('rateLimit', onRL);

	(async () => {
		let atual = 0,
			erros = 0,
			pedidos = 0,
			notasOk = 0,
			dmsOk = 0,
			servOk = 0,
			ultimoErroTipo = null;
		try {
			// 1) Pedidos de amizade
			if (idsUnicos.length) prog({ fase: 'pedidos' });
			for (const id of idsUnicos) {
				if (cancelado) break;
				try {
					await cliente.api.users['@me'].relationships[id].put({
						data: {},
						DiscordContext: { location: 'ContextMenu' }
					});
					pedidos++;
				} catch (e) {
					erros++;
					const m = e?.message || String(e);
					const status = e?.httpStatus || e?.status || e?.code;
					if (status === 429 || /rate ?limit|being blocked/i.test(m)) ultimoErroTipo = 'ratelimit';
					else if (/captcha/i.test(m)) ultimoErroTipo = 'captcha';
					prog({ ultimoErro: m, ultimoErroTipo });
				}
				atual++;
				prog({ atual, erros, pedidos });
				// CAPTCHA = conta sinalizada; para tudo (insistir só piora / arrisca ban).
				if (ultimoErroTipo === 'captcha') {
					cancelado = true;
					prog({ fase: 'captcha-parado' });
					break;
				}
				if (!cancelado && atual < total) await sleep(delayMin + Math.random() * (delayMax - delayMin));
			}
			// 2) Notas
			if (notas.length) prog({ fase: 'notas' });
			for (const n of notas) {
				if (cancelado) break;
				try {
					await cliente.notes.updateNote(String(n.id), String(n.nota));
					notasOk++;
				} catch (e) {
					erros++;
					prog({ ultimoErro: e?.message || String(e) });
				}
				atual++;
				prog({ atual, erros, notas: notasOk });
				if (!cancelado) await sleep(1 + Math.random() * 1.5);
			}
			// 3) Reabrir DMs
			if (dms.length) prog({ fase: 'dms' });
			for (const uid of dms) {
				if (cancelado) break;
				try {
					await cliente.api.users(cliente.user.id).channels.post({ data: { recipients: [uid] } });
					dmsOk++;
				} catch {
					erros++;
				}
				atual++;
				prog({ atual, erros, dms: dmsOk });
				if (!cancelado) await sleep(1 + Math.random() * 1.5);
			}
			// 4) Re-entrar em servidores (via convite salvo)
			if (servidores.length) prog({ fase: 'servidores' });
			for (const conviteRef of servidores) {
				if (cancelado) break;
				try {
					const code = String(conviteRef).replace(/^https?:\/\/(discord\.gg|discord\.com\/invite)\//i, '');
					await cliente.acceptInvite(code);
					servOk++;
				} catch (e) {
					erros++;
					const m = e?.message || String(e);
					if (/captcha/i.test(m)) ultimoErroTipo = 'captcha';
					prog({ ultimoErro: m, ultimoErroTipo });
				}
				atual++;
				prog({ atual, erros, servidores: servOk });
				if (ultimoErroTipo === 'captcha') {
					cancelado = true;
					prog({ fase: 'captcha-parado' });
					break;
				}
				// Entrar em servidor é MUITO sensível a flag — usa o mesmo delay dos pedidos.
				if (!cancelado && atual < total) await sleep(delayMin + Math.random() * (delayMax - delayMin));
			}
		} finally {
			try {
				cliente.off('rateLimit', onRL);
			} catch {}
			prog({ fase: 'concluido', atual, erros });
			setTimeout(() => ctx.tasks.removeTask(taskId).catch(() => {}), 5000);
		}
	})();

	return {
		sucesso: true,
		taskId,
		total,
		amigos: idsUnicos.length,
		notas: notas.length,
		dms: dms.length,
		servidores: servidores.length
	};
}

function userMini(u, id) {
	return {
		id: (u && u.id) || id,
		username: u?.username || null,
		globalName: u?.globalName || null,
		tag: u?.tag || null,
		avatar: u?.displayAvatarURL?.({ size: 128 }) || null
	};
}

// coll: Collection<id, user> (friendCache etc.) → array de userMini.
function fromCache(coll) {
	return Array.from(coll || []).map(([id, u]) => userMini(u, id));
}

// incluir: mapa opcional { amigos, notas, pedidos, bloqueados, servidores, dms }.
// Um campo === false exclui aquela seção; ausência/true inclui (padrão: tudo).
function montarBackupConta(cliente, incluir = {}) {
	const inc = (k) => incluir[k] !== false;
	const rel = cliente.relationships;
	const out = {
		app: 'pkthegoat-clear',
		versao: 1,
		gerado_em: new Date().toISOString(),
		conta: cliente.user
			? { id: cliente.user.id, tag: cliente.user.tag, username: cliente.user.username }
			: null
	};

	if (inc('amigos')) out.amigos = fromCache(rel?.friendCache);

	if (inc('pedidos')) {
		out.pedidos_recebidos = fromCache(rel?.incomingCache);
		out.pedidos_enviados = fromCache(rel?.outgoingCache);
	}

	if (inc('bloqueados')) out.bloqueados = fromCache(rel?.blockedCache);

	if (inc('notas')) {
		out.notas = [];
		for (const [id, nota] of cliente.notes?.cache || []) {
			if (!nota) continue;
			out.notas.push({ ...userMini(cliente.users?.cache?.get(id), id), nota });
		}
	}

	if (inc('servidores')) {
		out.servidores = Array.from(cliente.guilds?.cache?.values() || [])
			.map((g) => ({
				id: g.id,
				nome: g.name,
				dono: g.ownerId === cliente.user?.id,
				membros: g.memberCount || null
			}))
			.sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
	}

	if (inc('dms')) {
		out.dms = [];
		for (const ch of cliente.channels?.cache?.values() || []) {
			if (ch.type === 'DM') {
				const r = ch.recipient;
				out.dms.push({
					tipo: 'dm',
					id: ch.id,
					userId: r?.id || null,
					nome: r?.globalName || r?.username || null,
					tag: r?.tag || null
				});
			} else if (ch.type === 'GROUP_DM') {
				let nomes = [];
				try {
					if (ch.recipients) nomes = [...ch.recipients.values()].map((u) => u.globalName || u.username || u.id);
				} catch {}
				out.dms.push({
					tipo: 'grupo',
					id: ch.id,
					nome: ch.name || nomes.slice(0, 4).join(', ') || 'Grupo sem nome',
					participantes: (ch.recipients?.size ?? nomes.length) + 1
				});
			}
		}
	}

	out.resumo = {
		amigos: out.amigos?.length || 0,
		pedidos_recebidos: out.pedidos_recebidos?.length || 0,
		pedidos_enviados: out.pedidos_enviados?.length || 0,
		bloqueados: out.bloqueados?.length || 0,
		notas: out.notas?.length || 0,
		servidores: out.servidores?.length || 0,
		dms: out.dms?.length || 0
	};
	return out;
}

module.exports = { montarBackupConta, restaurarContaWeb, gerarConvitesServidores };
