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

function adicionarTokenUsuario(email, nome, token) {
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

function removerTokenUsuario(email, nome) {
    const d = lerDadosUsuario(email);
    const antes = (d.tokens || []).length;
    d.tokens = (d.tokens || []).filter((t) => t.nome !== nome);
    if (d.tokens.length === antes) return { sucesso: false, mensagem: 'Token não encontrada' };
    salvarDadosUsuario(email, d);
    return { sucesso: true };
}

function listarTokensUsuario(email) {
    const d = lerDadosUsuario(email);
    return (d.tokens || []).map((t) => ({ nome: t.nome }));
}

function deletarTodosDadosUsuario(email) {
    const p = userDataPath(email);
    if (fs.existsSync(p)) fs.unlinkSync(p);
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
        try {
            this.cliente.destroy();
        } catch {}
        this.cliente = null;
        this.comandosPrefix = null;
        this.automute.setClient(null);
        // Encerra todas as tarefas ativas do usuario
        await this.tasks.removeAllTasks().catch(() => {});
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

module.exports = {
    obterContexto,
    destruirContexto,
    adicionarTokenUsuario,
    removerTokenUsuario,
    listarTokensUsuario,
    lerDadosUsuario,
    salvarDadosUsuario,
    deletarTodosDadosUsuario
};
