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
const userHistory = require('./user-history');

// Janela de reuso da atividade dos amigos no snapshot (ver UserContext).
const FRIENDS_ACTIVITY_TTL_MS = 2500;

class AutomuteManager {
    constructor() {
        this.client = null;
        this.usuarios = new Map();
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
            if (!this.usuarios.has(newState.id)) return;
            if (!newState.channelId) return;
            if (oldState.channelId === newState.channelId && oldState.serverMute === newState.serverMute) return;
            if (newState.serverMute) return;
            try {
                await newState.setMute(true);
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

    async adicionar(userId) {
        if (!this.client) return { sucesso: false, motivo: 'cliente_indisponivel' };
        if (this.usuarios.has(userId)) {
            return { sucesso: false, motivo: 'ja_existe', tag: this.usuarios.get(userId) };
        }
        const usuario = await this.client.users.fetch(userId).catch(() => null);
        if (!usuario) return { sucesso: false, motivo: 'usuario_invalido' };
        this.usuarios.set(userId, usuario.tag);
        this.garantirListener();
        for (const [, guild] of this.client.guilds.cache) {
            const membro = guild.members.cache.get(userId);
            if (membro?.voice?.channel && !membro.voice.serverMute) {
                membro.voice.setMute(true).catch(() => {});
            }
        }
        return { sucesso: true, tag: usuario.tag };
    }

    remover(userId) {
        if (!this.usuarios.has(userId)) return { sucesso: false };
        const tag = this.usuarios.get(userId);
        this.usuarios.delete(userId);
        if (this.usuarios.size === 0) this.removerListener();
        return { sucesso: true, tag };
    }

    limpar() {
        const total = this.usuarios.size;
        this.usuarios.clear();
        this.removerListener();
        return total;
    }

    listar() {
        return Array.from(this.usuarios.entries()).map(([userId, tag]) => ({ userId, tag }));
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

async function adicionarTokenUsuario(email, nome, token) {
    if (supa.estaConfigurado()) {
        return await supa.adicionarToken(email, nome, token);
    }
    const d = lerDadosUsuario(email);
    if (!Array.isArray(d.tokens)) d.tokens = [];
    if (d.tokens.find((t) => t.token === token)) {
        return { sucesso: false, mensagem: 'Token já cadastrada' };
    }
    if (d.tokens.find((t) => t.nome === nome)) {
        return { sucesso: false, mensagem: 'Já existe token com esse nome' };
    }
    d.tokens.push({ nome, token });
    salvarDadosUsuario(email, d);
    return { sucesso: true };
}

async function removerTokenUsuario(email, nome) {
    if (supa.estaConfigurado()) {
        return await supa.removerToken(email, nome);
    }
    const d = lerDadosUsuario(email);
    const antes = (d.tokens || []).length;
    d.tokens = (d.tokens || []).filter((t) => t.nome !== nome);
    if (d.tokens.length === antes) return { sucesso: false, mensagem: 'Token não encontrada' };
    salvarDadosUsuario(email, d);
    return { sucesso: true };
}

async function listarTokensUsuario(email) {
    if (supa.estaConfigurado()) {
        return await supa.listarTokensUsuario(email);
    }
    const d = lerDadosUsuario(email);
    return (d.tokens || []).map((t) => ({ nome: t.nome }));
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
            if (ch) { guild = g; channel = ch; break; }
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
                id: fid, tag, avatar,
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
                id: fid, tag, avatar, status,
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
                id: fid, tag, avatar, status,
                track: trackName,
                artist,
                album,
                albumImg,
                trackId: spot.syncId || null
            });
        }

        // 4) Outras activities (jogos / apps)
        const playAct = acts.find((a) => (a?.type === 'PLAYING' || a?.type === 0));
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
                id: fid, tag, avatar, status,
                name: playAct.name,
                details: playAct.details || null,
                state: playAct.state || null,
                cover
            });
        }
    }

    const voice = Array.from(voiceGroups.values())
        .sort((a, b) => b.members.length - a.members.length);
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

    async conectarToken(token) {
        if (this.cliente) return { sucesso: false, mensagem: 'Já existe uma sessão conectada' };
        if (this.conectando) return { sucesso: false, mensagem: 'Conexão em andamento' };
        this.conectando = true;
        this.ultimoErroLogin = null;
        try {
            const novo = new Client({ checkUpdate: false });
            novo.on('error', () => {});
            await novo.login(token);
            this.cliente = novo;
            this.automute.setClient(novo);
            this.comandosPrefix = new ComandosPrefix(novo);
            this.comandosPrefix.iniciar();
            try { userHistory.attachClient(novo); } catch {}
            try { require('./voice-history').attachClient(novo); } catch {}
            try { if (novo.user) userHistory.recordUser(novo.user); } catch {}
            // Marca este token como ativo para reconectar sozinho após um restart
            // do processo. Só persiste tokens já salvos (cifrados) no Supabase.
            try { if (supa.estaConfigurado()) this.tokenNomeAtivo = await supa.marcarTokenAtivo(this.email, token); } catch {}
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

    async desconectar() {
        if (!this.cliente) return { sucesso: false, mensagem: 'Não conectado' };
        // Desconexão explícita pelo usuário: não reconectar no próximo boot.
        try { if (supa.estaConfigurado()) await supa.limparTokenAtivo(this.email); } catch {}
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
            try { c.destroy(); } catch {}
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
            if (v) farmCalls.push({ ...v, conta: { id: c.user?.id, tag: c.user?.tag, avatar: c.user?.displayAvatarURL?.({ size: 128 }) || null } });
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

async function destruirContexto(email) {
    const e = String(email || '').toLowerCase();
    const ctx = contextos.get(e);
    if (!ctx) return;
    await ctx.desconectar().catch(() => {});
    contextos.delete(e);
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
    try { ativos = await supa.listarTokensAtivos(); } catch { return { reconectados: 0, total: 0 }; }
    const { sleepMs } = require('../utils/sleep');
    let ok = 0;
    for (let i = 0; i < ativos.length; i += RECONNECT_LOTE) {
        const lote = ativos.slice(i, i + RECONNECT_LOTE);
        await Promise.all(lote.map(async (a, idx) => {
            // Espaça os logins DENTRO do lote também, pra não abrir todos no
            // mesmo tick e evitar rate-limit do gateway do Discord.
            if (idx) await sleepMs(idx * RECONNECT_GAP_MS);
            try {
                const ctx = obterContexto(a.email);
                if (ctx.cliente) return;
                const r = await ctx.conectarToken(a.token);
                if (r && r.sucesso) ok++;
                else { await supa.limparTokenAtivo(a.email).catch(() => {}); }
            } catch {}
        }));
        // Pausa entre lotes, deixando o event loop atender requests do painel.
        if (i + RECONNECT_LOTE < ativos.length) await sleepMs(RECONNECT_LOTE_GAP_MS);
    }
    return { reconectados: ok, total: ativos.length };
}

module.exports = {
    obterContexto,
    destruirContexto,
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
