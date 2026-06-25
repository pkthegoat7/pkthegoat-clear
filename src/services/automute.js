const chalk = require('chalk');

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
            } catch (erro) {
                console.error(chalk.red('Erro no automute:'), erro);
            }
        };

        this.client.on('voiceStateUpdate', this.listener);
    }

    removerListener() {
        if (this.client && this.listener) {
            this.client.off('voiceStateUpdate', this.listener);
        }
        this.listener = null;
    }

    removerListenerSeOcioso() {
        if (this.usuarios.size === 0) {
            this.removerListener();
        }
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

    // Desmuta o alvo (server-unmute) na call em que ele estiver.
    // NÃO checa serverMute do cache de propósito: esse cache costuma ficar
    // desatualizado e fazia o desmute ser pulado. setMute(false) em quem já está
    // sem mute é inofensivo. Fire-and-forget; loga erro pra aparecer nos logs.
    desmutar(userId) {
        if (!this.client) return;
        for (const [, guild] of this.client.guilds.cache) {
            const membro = guild.members.cache.get(userId);
            if (membro?.voice?.channel) {
                membro.voice.setMute(false).catch((erro) => {
                    console.error(chalk.red('Erro ao desmutar (automute off):'), erro?.message || erro);
                });
                return; // o usuário só está numa call por vez
            }
        }
    }

    remover(userId) {
        if (!this.usuarios.has(userId)) {
            return { sucesso: false, motivo: 'nao_estava' };
        }
        const tag = this.usuarios.get(userId);
        // Tira da lista ANTES de desmutar: assim o listener (que checa a lista) não
        // re-muta o alvo ao receber o voiceStateUpdate gerado pelo próprio unmute.
        this.usuarios.delete(userId);
        this.desmutar(userId);
        this.removerListenerSeOcioso();
        return { sucesso: true, tag };
    }

    limpar() {
        const total = this.usuarios.size;
        const ids = Array.from(this.usuarios.keys());
        this.usuarios.clear();
        for (const id of ids) this.desmutar(id);
        this.removerListener();
        return total;
    }

    listar() {
        return Array.from(this.usuarios.entries()).map(([userId, tag]) => ({ userId, tag }));
    }

    contem(userId) {
        return this.usuarios.has(userId);
    }
}

const automuteManager = new AutomuteManager();

module.exports = { automuteManager };
