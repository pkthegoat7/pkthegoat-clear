/**
 * Contexto isolado por usuario do painel.
 * Cada usuario tem seu proprio cliente Discord, AutomuteManager, BackgroundTaskManager,
 * tokens armazenados, etc.
 *
 * Nenhum dado de um usuario deve ser acessivel a partir de outro.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('discord.js-selfbot-v13');
const { BackgroundTaskManager } = require('../utils/backgroundTasks');
const ComandosPrefix = require('../features/comandos-prefix');
const { dataDir } = require('./auth');
const supa = require('./supabase');
const captchaBridge = require('./captcha-bridge');
const userHistory = require('./user-history');

// Janela de reuso da atividade dos amigos no snapshot (ver UserContext).
const FRIENDS_ACTIVITY_TTL_MS = 2500;

class AutomuteManager {
	constructor() {
		this.client = null;
		this.usuarios = new Map();
		// IDs que, além do mic, também devem ter o ouvido mutado (server-deafen).
		this.ensurdecer = new Set();
		this.listener = null;
	}

	setClient(client) {
		if (this.client === client) return;
		this.removerListener();
		this.client = client;
	}

	garantirListener() {
		if (!this.client || this.listener) return;
		this.listener = async (oldState, newState) => {
			const id = newState.id;
			if (!this.usuarios.has(id)) return;
			if (!newState.channelId) return;
			const querDeaf = this.ensurdecer.has(id);
			const precisaMute = !newState.serverMute;
			const precisaDeaf = querDeaf && !newState.serverDeaf;
			if (oldState.channelId === newState.channelId && oldState.serverMute === newState.serverMute && oldState.serverDeaf === newState.serverDeaf) return;
			if (!precisaMute && !precisaDeaf) return;
			try {
				if (precisaMute) await newState.setMute(true);
				if (precisaDeaf) await newState.setDeaf(true);
			} catch {}
		};
		this.client.on('voiceStateUpdate', this.listener);
	}

	removerListener() {
		if (this.client && this.listener) {
			this.client.off('voiceStateUpdate', this.listener);
		}
		this.listener = null;
	}

	async adicionar(userId, deafen = false) {
		if (!this.client) return { sucesso: false, motivo: 'cliente_indisponivel' };
		if (this.usuarios.has(userId)) {
			return { sucesso: false, motivo: 'ja_existe', tag: this.usuarios.get(userId) };
		}
		const usuario = await this.client.users.fetch(userId).catch(() => null);
		if (!usuario) return { sucesso: false, motivo: 'usuario_invalido' };
		this.usuarios.set(userId, usuario.tag);
		if (deafen) this.ensurdecer.add(userId);
		this.garantirListener();
		for (const [, guild] of this.client.guilds.cache) {
			const membro = guild.members.cache.get(userId);
			if (membro?.voice?.channel) {
				if (!membro.voice.serverMute) membro.voice.setMute(true).catch(() => {});
				if (deafen && !membro.voice.serverDeaf) membro.voice.setDeaf(true).catch(() => {});
			}
		}
		return { sucesso: true, tag: usuario.tag, deafen };
	}

	// Restaura (unmute + undeafen) o alvo na call em que estiver. Usado ao
	// remover/limpar para não deixar ninguém preso mutado/ensurdecido.
	restaurar(userId, tirarDeaf) {
		if (!this.client) return;
		for (const [, guild] of this.client.guilds.cache) {
			const vs = guild.voiceStates.cache.get(userId);
			if (vs?.channelId) {
				vs.setMute(false).catch(() => {});
				if (tirarDeaf) vs.setDeaf(false).catch(() => {});
				return;
			}
		}
	}

	remover(userId) {
		if (!this.usuarios.has(userId)) return { sucesso: false };
		const tag = this.usuarios.get(userId);
		const tirarDeaf = this.ensurdecer.has(userId);
		this.usuarios.delete(userId);
		this.ensurdecer.delete(userId);
		this.restaurar(userId, tirarDeaf);
		if (this.usuarios.size === 0) this.removerListener();
		return { sucesso: true, tag };
	}

	limpar() {
		const total = this.usuarios.size;
		const ids = Array.from(this.usuarios.keys());
		const deafs = new Set(this.ensurdecer);
		this.usuarios.clear();
		this.ensurdecer.clear();
		for (const id of ids) this.restaurar(id, deafs.has(id));
		this.removerListener();
		return total;
	}

	// Religa o automute no client atual sem perder a lista de usuários. Usado após
	// uma troca de token: o setClient(novo) apaga o listener, mas os alvos seguem.
	// Reanexa o listener e re-muta quem já está em call agora.
	reativar() {
		if (!this.client || this.usuarios.size === 0) return;
		this.garantirListener();
		for (const userId of this.usuarios.keys()) {
			for (const [, guild] of this.client.guilds.cache) {
				const membro = guild.members.cache.get(userId);
				if (membro?.voice?.channel) {
					if (!membro.voice.serverMute) membro.voice.setMute(true).catch(() => {});
					if (this.ensurdecer.has(userId) && !membro.voice.serverDeaf) membro.voice.setDeaf(true).catch(() => {});
				}
			}
		}
	}

	listar() {
		return Array.from(this.usuarios.entries()).map(([userId, tag]) => ({ userId, tag, deafen: this.ensurdecer.has(userId) }));
	}
}

// ====================== Dados de usuario (tokens etc.) ======================
function userDataDir() {
	const d = path.join(dataDir(), 'user-data');
	if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
	return d;
}

function sanitizarEmailParaArquivo(email) {
	return crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 32);
}

function userDataPath(email) {
	return path.join(userDataDir(), `${sanitizarEmailParaArquivo(email)}.json`);
}

function lerDadosUsuario(email) {
	const p = userDataPath(email);
	if (!fs.existsSync(p)) return { tokens: [] };
	try {
		return JSON.parse(fs.readFileSync(p, 'utf8'));
	} catch {
		return { tokens: [] };
	}
}

function salvarDadosUsuario(email, dados) {
	fs.writeFileSync(userDataPath(email), JSON.stringify(dados, null, 2));
}

// Cache curto da LISTA de tokens (só nomes) por usuário. /api/tokens e a tela
// de tokens batiam no Supabase a cada carga; a lista muda pouco e é invalidada
// ao adicionar/remover. TTL curto pra refletir rápido mesmo se algo escapar.
const _tokenListCache = new Map(); // email(lower) -> { lista, at }
const TOKEN_LIST_TTL_MS = 15 * 1000;
function invalidarTokenListCache(email) {
	_tokenListCache.delete(String(email || '').toLowerCase());
}

async function adicionarTokenUsuario(email, nome, token) {
	let r;
	if (supa.estaConfigurado()) {
		r = await supa.adicionarToken(email, nome, token);
	} else {
		const d = lerDadosUsuario(email);
		if (!Array.isArray(d.tokens)) d.tokens = [];
		if (d.tokens.find((t) => t.token === token)) {
			r = { sucesso: false, mensagem: 'Token já cadastrada' };
		} else if (d.tokens.find((t) => t.nome === nome)) {
			r = { sucesso: false, mensagem: 'Já existe token com esse nome' };
		} else {
			d.tokens.push({ nome, token });
			salvarDadosUsuario(email, d);
			r = { sucesso: true };
		}
	}
	invalidarTokenListCache(email);
	return r;
}

async function removerTokenUsuario(email, nome) {
	let r;
	if (supa.estaConfigurado()) {
		r = await supa.removerToken(email, nome);
	} else {
		const d = lerDadosUsuario(email);
		const antes = (d.tokens || []).length;
		d.tokens = (d.tokens || []).filter((t) => t.nome !== nome);
		if (d.tokens.length === antes) r = { sucesso: false, mensagem: 'Token não encontrada' };
		else {
			salvarDadosUsuario(email, d);
			r = { sucesso: true };
		}
	}
	invalidarTokenListCache(email);
	return r;
}

async function listarTokensUsuario(email) {
	const chave = String(email || '').toLowerCase();
	const c = _tokenListCache.get(chave);
	if (c && Date.now() - c.at < TOKEN_LIST_TTL_MS) return c.lista;
	let lista;
	if (supa.estaConfigurado()) {
		lista = await supa.listarTokensUsuario(email);
	} else {
		const d = lerDadosUsuario(email);
		lista = (d.tokens || []).map((t) => ({ nome: t.nome }));
	}
	_tokenListCache.set(chave, { lista, at: Date.now() });
	return lista;
}

async function buscarTokenUsuario(email, nome) {
	if (supa.estaConfigurado()) {
		return await supa.buscarTokenPorNome(email, nome);
	}
	const d = lerDadosUsuario(email);
	return (d.tokens || []).find((t) => t.nome === nome) || null;
}

async function listarTokensComValor(email) {
	if (supa.estaConfigurado()) {
		return await supa.listarTokensComValor(email);
	}
	const d = lerDadosUsuario(email);
	return d.tokens || [];
}

async function deletarTodosDadosUsuario(email) {
	if (supa.estaConfigurado()) {
		await supa.deletarTodosTokensDoUsuario(email);
		return;
	}
	const p = userDataPath(email);
	if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ====================== Voice snapshot helper ======================
function extrairVoice(client) {
	if (!client?.guilds?.cache) return null;
	const selfId = client.user?.id;
	if (!selfId) return null;

	let guild = null;
	let channel = null;
	for (const [, g] of client.guilds.cache) {
		const me = g.members?.me || g.members?.cache?.get(selfId);
		const chId = me?.voice?.channelId;
		if (chId) {
			const ch = g.channels?.cache?.get(chId);
			if (ch) {
				guild = g;
				channel = ch;
				break;
			}
		}
	}
	if (!channel) return null;

	const membros = [];
	const states = channel.guild?.voiceStates?.cache;
	// Coleta IDs por states e por channel.members (mais robusto)
	const ids = new Set();
	if (states) {
		for (const [uid, st] of states) {
			if (st.channelId === channel.id) ids.add(uid);
		}
	}
	if (channel.members?.size) {
		for (const [uid] of channel.members) ids.add(uid);
	}
	for (const uid of ids) {
		const st = states?.get(uid);
		const m = channel.members?.get(uid) || channel.guild.members?.cache?.get(uid);
		const usr = m?.user || client.users?.cache?.get(uid);
		const vs = m?.voice || st;
		membros.push({
			id: uid,
			tag: usr?.tag || usr?.username || uid,
			avatar: usr?.displayAvatarURL?.({ size: 64 }) || null,
			self: uid === selfId,
			mute: !!(vs?.mute || vs?.selfMute || vs?.serverMute),
			deaf: !!(vs?.deaf || vs?.selfDeaf || vs?.serverDeaf),
			streaming: !!vs?.streaming,
			video: !!vs?.selfVideo
		});
	}
	membros.sort((a, b) => (b.self ? 1 : 0) - (a.self ? 1 : 0) || a.tag.localeCompare(b.tag));

	return {
		guild: {
			id: guild.id,
			name: guild.name,
			icon: guild.iconURL?.({ size: 64 }) || null
		},
		channel: {
			id: channel.id,
			name: channel.name,
			userLimit: channel.userLimit || 0,
			type: channel.type
		},
		members: membros,
		count: membros.length
	};
}

// ====================== Friends activity helper ======================
// Indexa presença e voz de TODOS os amigos numa única varredura dos guilds,
// em vez de varrer todos os guilds uma vez POR amigo. A versão antiga era
// O(amigos × guilds) por poll (e, no pior caso — amigo offline/fora de voz —
// varria todos os guilds inteiros pra cada amigo), o que afogava o event loop
// single-thread e deixava o painel lento. Aqui percorremos os caches de cada
// guild uma vez só: custo O(entradas em cache), com lookup O(1) por amigo.
function indexarAmigos(client, friendIds) {
	const presenceByUser = new Map();
	const voiceByUser = new Map();
	for (const [, g] of client.guilds.cache) {
		const pres = g.presences?.cache;
		if (pres) {
			for (const [uid, p] of pres) {
				if (friendIds.has(uid) && !presenceByUser.has(uid)) presenceByUser.set(uid, p);
			}
		}
		const vs = g.voiceStates?.cache;
		if (vs) {
			for (const [uid, st] of vs) {
				if (st?.channelId && friendIds.has(uid) && !voiceByUser.has(uid)) {
					const ch = g.channels?.cache?.get(st.channelId);
					if (ch) voiceByUser.set(uid, { guild: g, channel: ch, state: st });
				}
			}
		}
	}
	return { presenceByUser, voiceByUser };
}

function extrairFriendsActivity(client) {
	const friends = client?.relationships?.friendCache;
	if (!friends?.size) return { voice: [], spotify: [], streaming: [], playing: [] };

	const selfId = client.user?.id;
	const voiceGroups = new Map(); // `${guildId}:${channelId}` -> { guild, channel, members[] }
	const spotify = [];
	const streaming = [];
	const playing = [];

	// Uma única passada pelos caches dos guilds resolve presença/voz de todos os amigos.
	const friendIds = new Set(friends.keys());
	const { presenceByUser, voiceByUser } = indexarAmigos(client, friendIds);

	for (const [fid, friend] of friends) {
		if (fid === selfId) continue;
		const usr = friend?.user || friend;
		const tag = usr?.tag || usr?.username || fid;
		const avatar = usr?.displayAvatarURL?.({ size: 64 }) || null;

		const presence = presenceByUser.get(fid) || null;
		const v = voiceByUser.get(fid) || null;
		const status = presence?.status || 'offline';
		const acts = presence?.activities || [];

		// 1) Voice — pega o estado real, não a activity
		if (v) {
			const key = `${v.guild.id}:${v.channel.id}`;
			if (!voiceGroups.has(key)) {
				voiceGroups.set(key, {
					guild: { id: v.guild.id, name: v.guild.name, icon: v.guild.iconURL?.({ size: 32 }) || null },
					channel: { id: v.channel.id, name: v.channel.name },
					members: []
				});
			}
			voiceGroups.get(key).members.push({
				id: fid,
				tag,
				avatar,
				mute: !!(v.state.mute || v.state.selfMute),
				deaf: !!(v.state.deaf || v.state.selfDeaf),
				streaming: !!v.state.streaming,
				video: !!v.state.selfVideo
			});
		}

		// 2) Streaming (Go Live ou twitch streaming)
		const streamAct = acts.find((a) => a?.type === 'STREAMING' || a?.type === 1);
		const isLive = !!streamAct || !!v?.state?.streaming;
		if (isLive) {
			streaming.push({
				id: fid,
				tag,
				avatar,
				status,
				channel: v ? { name: v.channel.name, guild: v.guild.name } : null,
				channelId: v?.channel?.id || null,
				guildId: v?.guild?.id || null,
				title: streamAct?.details || streamAct?.name || 'Compartilhando tela',
				url: streamAct?.url || null
			});
		}

		// 3) Spotify
		const spot = acts.find((a) => a?.name === 'Spotify' && (a?.type === 'LISTENING' || a?.type === 2));
		if (spot) {
			const trackName = spot.details || spot.state || null;
			const artist = spot.state || null;
			const album = spot.assets?.largeText || null;
			let albumImg = null;
			const largeImg = spot.assets?.largeImage || spot.assets?.large_image;
			if (largeImg && typeof largeImg === 'string') {
				const m = largeImg.match(/^spotify:(.+)$/);
				if (m) albumImg = `https://i.scdn.co/image/${m[1]}`;
			}
			spotify.push({
				id: fid,
				tag,
				avatar,
				status,
				track: trackName,
				artist,
				album,
				albumImg,
				trackId: spot.syncId || null
			});
		}

		// 4) Outras activities (jogos / apps)
		const playAct = acts.find((a) => a?.type === 'PLAYING' || a?.type === 0);
		if (playAct && !spot && !streamAct) {
			const largeImg = playAct.assets?.largeImage || playAct.assets?.large_image;
			let cover = null;
			if (largeImg && typeof largeImg === 'string') {
				const mp = largeImg.match(/^mp:external\/.+\/(https?\/.+)$/);
				if (mp) {
					cover = `https://media.discordapp.net/external/${mp[1]}`;
				} else if (playAct.applicationId) {
					cover = `https://cdn.discordapp.com/app-assets/${playAct.applicationId}/${largeImg}.png`;
				}
			}
			playing.push({
				id: fid,
				tag,
				avatar,
				status,
				name: playAct.name,
				details: playAct.details || null,
				state: playAct.state || null,
				cover
			});
		}
	}

	const voice = Array.from(voiceGroups.values()).sort((a, b) => b.members.length - a.members.length);
	spotify.sort((a, b) => a.tag.localeCompare(b.tag));
	streaming.sort((a, b) => a.tag.localeCompare(b.tag));
	playing.sort((a, b) => a.tag.localeCompare(b.tag));

	return { voice, spotify, streaming, playing };
}

// ====================== UserContext ======================
class UserContext {
	constructor(email) {
		this.email = email;
		this.cliente = null;
		this.automute = new AutomuteManager();
		this.tasks = new BackgroundTaskManager();
		this.comandosPrefix = null;
		this.conectando = false;
		this.ultimoErroLogin = null;
		this.tokensDescobertos = new Map();
		this.sessionCounter = 0;
		// Nome do token salvo correspondente ao self conectado (p/ a aba "Tela
		// do self", que precisa dizer ao serviço de browser qual token abrir).
		this.tokenNomeAtivo = null;
		// Clientes Discord extras usados pra farmar várias contas simultaneamente.
		// Map<userId, Client>. Cada client é destruído quando a tarefa associada é parada.
		this.farmClients = new Map();
		// Memo da atividade dos amigos (parte cara do snapshot). O poll do painel
		// bate a cada ~2s; recalcular a varredura de amigos a cada bate afogava o
		// event loop. Reusamos por FRIENDS_ACTIVITY_TTL_MS — a atividade muda devagar
		// e o resto do status (voz própria/tarefas) continua fresco a cada poll.
		this._friendsActivityCache = null;
		this._friendsActivityAt = 0;
	}

	// Recalcula a atividade dos amigos no máximo a cada FRIENDS_ACTIVITY_TTL_MS.
	obterFriendsActivity() {
		if (!this.cliente) return { voice: [], spotify: [], streaming: [], playing: [] };
		const agora = Date.now();
		if (this._friendsActivityCache && agora - this._friendsActivityAt < FRIENDS_ACTIVITY_TTL_MS) {
			return this._friendsActivityCache;
		}
		this._friendsActivityCache = extrairFriendsActivity(this.cliente);
		this._friendsActivityAt = agora;
		return this._friendsActivityCache;
	}

	// Opções do Client, incluindo o captchaSolver que joga o captcha pro painel
	// (o usuário resolve o hCaptcha na tela e a lib reenvia o request com o token).
	_opcoesClient() {
		const email = this.email;
		return {
			checkUpdate: false,
			captchaRetryLimit: 3,
			captchaSolver: (captcha) => captchaBridge.solicitarCaptcha(email, captcha)
		};
	}

	async conectarToken(token) {
		if (this.cliente) return { sucesso: false, mensagem: 'Já existe uma sessão conectada' };
		if (this.conectando) return { sucesso: false, mensagem: 'Conexão em andamento' };
		this.conectando = true;
		this.ultimoErroLogin = null;
		try {
			const novo = new Client(this._opcoesClient());
			novo.on('error', () => {});
			await novo.login(token);
			this.cliente = novo;
			this.automute.setClient(novo);
			this.comandosPrefix = new ComandosPrefix(novo);
			this.comandosPrefix.iniciar();
			try {
				userHistory.attachClient(novo);
			} catch {}
			try {
				require('./voice-history').attachClient(novo);
			} catch {}
			try {
				if (novo.user) userHistory.recordUser(novo.user);
			} catch {}
			// Aplica o Rich Presence configurado assim que a conta conecta no gateway.
			try {
				require('./rpc').aplicarEmCliente(novo);
			} catch {}
			// Marca este token como ativo para reconectar sozinho após um restart
			// do processo. Só persiste tokens já salvos (cifrados) no Supabase.
			try {
				if (supa.estaConfigurado()) this.tokenNomeAtivo = await supa.marcarTokenAtivo(this.email, token);
			} catch {}
			this.conectando = false;
			return {
				sucesso: true,
				usuario: {
					id: novo.user.id,
					tag: novo.user.tag,
					username: novo.user.username,
					avatar: novo.user.displayAvatarURL?.({ size: 256 }) || null
				}
			};
		} catch (e) {
			this.conectando = false;
			this.ultimoErroLogin = e.message || 'Erro desconhecido';
			return { sucesso: false, mensagem: this.ultimoErroLogin };
		}
	}

	// Troca "quente" de token (make-before-break): conecta o novo self ANTES de
	// derrubar o antigo e PRESERVA as funções em andamento — tarefas em background,
	// farmClients e a lista do automute seguem vivas, agora operando pelo novo self.
	// Diferente de desconectar()+conectarToken() (que zeram tudo). Usado ao trocar
	// de conta no app local. Sem sessão atual, cai num conectarToken normal.
	async trocarToken(token) {
		if (!this.cliente) return this.conectarToken(token);
		if (this.conectando) return { sucesso: false, mensagem: 'Conexão em andamento' };
		this.conectando = true;
		this.ultimoErroLogin = null;
		let novo;
		try {
			novo = new Client(this._opcoesClient());
			novo.on('error', () => {});
			await novo.login(token); // conecta ANTES de derrubar o antigo
		} catch (e) {
			try {
				novo?.destroy();
			} catch {}
			this.conectando = false;
			this.ultimoErroLogin = e.message || 'Erro desconhecido';
			// Falha no login: o self antigo continua intacto (nada foi derrubado).
			return { sucesso: false, mensagem: this.ultimoErroLogin };
		}
		const antigo = this.cliente;
		this.cliente = novo;
		this._friendsActivityCache = null;
		this._friendsActivityAt = 0;
		// Automute do contexto (usado pelo painel): rebinda no novo self e religa,
		// mantendo a lista de alvos.
		this.automute.setClient(novo);
		this.automute.reativar();
		// Comandos de prefixo: o construtor rebinda o automute singleton no novo
		// self; recria o listener de comandos e religa o automute singleton (a
		// lista de alvos dele também persiste).
		try {
			this.comandosPrefix = new ComandosPrefix(novo);
			this.comandosPrefix.iniciar();
			require('./automute').automuteManager.reativar();
		} catch {}
		try {
			userHistory.attachClient(novo);
		} catch {}
		try {
			require('./voice-history').attachClient(novo);
		} catch {}
		try {
			if (novo.user) userHistory.recordUser(novo.user);
		} catch {}
		// Rich Presence configurado no novo self.
		try {
			require('./rpc').aplicarEmCliente(novo);
		} catch {}
		// Marca o novo token como ativo p/ reconexão automática no próximo boot.
		try {
			if (supa.estaConfigurado()) this.tokenNomeAtivo = await supa.marcarTokenAtivo(this.email, token);
		} catch {}
		// Só agora derruba o self antigo (make-before-break). NÃO mexe em this.tasks
		// nem em farmClients — eles seguem rodando com os próprios tokens.
		try {
			antigo.destroy();
		} catch {}
		this.conectando = false;
		return {
			sucesso: true,
			usuario: {
				id: novo.user.id,
				tag: novo.user.tag,
				username: novo.user.username,
				avatar: novo.user.displayAvatarURL?.({ size: 256 }) || null
			}
		};
	}

	async desconectar() {
		if (!this.cliente) return { sucesso: false, mensagem: 'Não conectado' };
		// Desconexão explícita pelo usuário: não reconectar no próximo boot.
		try {
			if (supa.estaConfigurado()) await supa.limparTokenAtivo(this.email);
		} catch {}
		this.tokenNomeAtivo = null;
		try {
			this.cliente.destroy();
		} catch {}
		this.cliente = null;
		this.comandosPrefix = null;
		this.automute.setClient(null);
		// Encerra todas as tarefas ativas do usuario (stop callbacks já destroem farmClients)
		await this.tasks.removeAllTasks().catch(() => {});
		// Garantia: destrói qualquer farm client remanescente
		for (const [, c] of this.farmClients) {
			try {
				c.destroy();
			} catch {}
		}
		this.farmClients.clear();
		return { sucesso: true };
	}

	snapshotAuth() {
		return {
			conectado: !!this.cliente,
			conectando: this.conectando,
			ultimoErro: this.ultimoErroLogin,
			usuario: this.cliente?.user
				? {
						id: this.cliente.user.id,
						tag: this.cliente.user.tag,
						username: this.cliente.user.username,
						avatar: this.cliente.user.displayAvatarURL?.({ size: 256 }) || null
					}
				: null
		};
	}

	snapshotStatus() {
		const tasks = this.tasks.getTasks().map((t) => ({
			id: t.id,
			name: t.name,
			startedAt: t.startedAt,
			data: t.data || {}
		}));
		const automute = this.automute.listar();
		const u = this.cliente?.user || null;
		const voice = this.cliente ? extrairVoice(this.cliente) : null;
		const farmCalls = [];
		for (const [, c] of this.farmClients) {
			const v = extrairVoice(c);
			if (v)
				farmCalls.push({
					...v,
					conta: { id: c.user?.id, tag: c.user?.tag, avatar: c.user?.displayAvatarURL?.({ size: 128 }) || null }
				});
		}
		const friendsActivity = this.obterFriendsActivity();
		return {
			bot: u
				? {
						id: u.id,
						tag: u.tag,
						username: u.username,
						avatar: u.displayAvatarURL?.({ size: 256 }) || null,
						guilds: this.cliente.guilds?.cache?.size || 0,
						friends: this.cliente.relationships?.friendCache?.size || 0,
						dms: this.cliente.channels?.cache?.filter?.((c) => c.type === 'DM')?.size || 0
					}
				: null,
			voice,
			farmCalls,
			friendsActivity,
			tasks,
			automute
		};
	}
}

// ====================== Registry de contextos ======================
const contextos = new Map(); // email -> UserContext

function obterContexto(email) {
	const e = String(email || '').toLowerCase();
	if (!contextos.has(e)) {
		contextos.set(e, new UserContext(e));
	}
	return contextos.get(e);
}

// Clients principais (self) conectados no gateway, um por contexto. Usado pelo
// serviço de Rich Presence pra saber onde aplicar a atividade. NÃO inclui os
// farmClients temporários.
function clientesConectados() {
	const arr = [];
	for (const [, ctx] of contextos) {
		if (ctx.cliente && ctx.cliente.user) arr.push(ctx.cliente);
	}
	return arr;
}

// Reconecta no arranque do servidor todos os selfs marcados como ativos no
// Supabase (ver marcarTokenAtivo). É o que faz a conta voltar sozinha após o
// Railway reiniciar o container. Tolerante a falhas: um token revogado limpa o
// próprio flag e os demais seguem. No-op sem Supabase (modo local).
//
// Reconexão em LOTES com espaçamento: antes fazíamos Promise.all de todas as
// contas de uma vez, então no boot dezenas de logins do Discord (cada um
// abrindo gateway + cacheando guilds) saturavam o event loop single-thread e
// o painel ficava lento pra carregar justamente no arranque. Agora vão poucas
// por vez, com pausa entre logins e entre lotes, deixando o loop respirar pra
// atender o HTTP.
const RECONNECT_LOTE = Number(process.env.PKT_RECONNECT_LOTE) || 3;
const RECONNECT_GAP_MS = Number(process.env.PKT_RECONNECT_GAP_MS) || 800;
const RECONNECT_LOTE_GAP_MS = Number(process.env.PKT_RECONNECT_LOTE_GAP_MS) || 2500;

async function reconectarSessoesSalvas() {
	if (!supa.estaConfigurado()) return { reconectados: 0, total: 0 };
	let ativos = [];
	try {
		ativos = await supa.listarTokensAtivos();
	} catch {
		return { reconectados: 0, total: 0 };
	}
	const { sleepMs } = require('../utils/sleep');
	let ok = 0;
	for (let i = 0; i < ativos.length; i += RECONNECT_LOTE) {
		const lote = ativos.slice(i, i + RECONNECT_LOTE);
		await Promise.all(
			lote.map(async (a, idx) => {
				// Espaça os logins DENTRO do lote também, pra não abrir todos no
				// mesmo tick e evitar rate-limit do gateway do Discord.
				if (idx) await sleepMs(idx * RECONNECT_GAP_MS);
				try {
					const ctx = obterContexto(a.email);
					if (ctx.cliente) return;
					const r = await ctx.conectarToken(a.token);
					if (r && r.sucesso) ok++;
					else {
						await supa.limparTokenAtivo(a.email).catch(() => {});
					}
				} catch {}
			})
		);
		// Pausa entre lotes, deixando o event loop atender requests do painel.
		if (i + RECONNECT_LOTE < ativos.length) await sleepMs(RECONNECT_LOTE_GAP_MS);
	}
	return { reconectados: ok, total: ativos.length };
}

module.exports = {
	obterContexto,
	clientesConectados,
	reconectarSessoesSalvas,
	adicionarTokenUsuario,
	removerTokenUsuario,
	listarTokensUsuario,
	buscarTokenUsuario,
	listarTokensComValor,
	lerDadosUsuario,
	salvarDadosUsuario,
	deletarTodosDadosUsuario
};
