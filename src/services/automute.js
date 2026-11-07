const chalk = require('chalk');

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

            // Só reage quando algo relevante mudou (canal, mute ou deaf).
            if (
                oldState.channelId === newState.channelId &&
                oldState.serverMute === newState.serverMute &&
                oldState.serverDeaf === newState.serverDeaf
            ) return;
            if (!precisaMute && !precisaDeaf) return;

            try {
                if (precisaMute) await newState.setMute(true);
                if (precisaDeaf) await newState.setDeaf(true);
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

    async adicionar(userId, deafen = false) {
        if (!this.client) return { sucesso: false, motivo: 'cliente_indisponivel' };
        if (this.usuarios.has(userId)) {
            return { sucesso: false, motivo: 'ja_existe', tag: this.usuarios.get(userId) };
        }

        const usuario = await this.client.users.fetch(userId).catch(() => null);
        if (!usuario) return { sucesso: false, motivo: 'usuario_invalido' };

        this.usuarios.set(userId, usuario.tag);
        if (deafen) this.ensurdecer.add(userId);
        console.log(chalk.cyan(`[automute] adicionado ${userId} (${usuario.tag})${deafen ? ' [+ensurdecer]' : ''}`));
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

    // Desmuta o alvo (server-unmute) na call em que ele estiver.
    // Usa guild.voiceStates.cache (mesma fonte do listener que faz o mute), porque
    // em selfbot o guild.members.cache costuma estar incompleto. Não checa serverMute
    // de propósito (cache desatualizado pulava o desmute). Loga pra diagnóstico.
    desmutar(userId) {
        if (!this.client) return;
        const tirarDeaf = this.ensurdecer.has(userId);
        for (const [, guild] of this.client.guilds.cache) {
            const vs = guild.voiceStates.cache.get(userId);
            if (vs?.channelId) {
                console.log(chalk.cyan(`[automute] desmutando ${userId} em "${guild.name}" (canal ${vs.channelId})`));
                vs.setMute(false)
                    .then(() => console.log(chalk.green(`[automute] desmute OK: ${userId}`)))
                    .catch((erro) => console.error(chalk.red('[automute] erro ao desmutar:'), erro?.message || erro));
                if (tirarDeaf) {
                    vs.setDeaf(false)
                        .then(() => console.log(chalk.green(`[automute] desensurdecer OK: ${userId}`)))
                        .catch((erro) => console.error(chalk.red('[automute] erro ao desensurdecer:'), erro?.message || erro));
                }
                return; // o usuário só está numa call por vez
            }
        }
        console.log(chalk.yellow(`[automute] desmute: ${userId} não está em nenhuma call visível.`));
    }

    remover(userId) {
        const naLista = this.usuarios.has(userId);
        console.log(chalk.cyan(`[automute] remover(${userId}) | naLista=${naLista} | listaAtual=[${Array.from(this.usuarios.keys()).join(', ')}]`));
        if (!naLista) {
            return { sucesso: false, motivo: 'nao_estava' };
        }
        const tag = this.usuarios.get(userId);
        // Tira da lista ANTES de desmutar: assim o listener (que checa a lista) não
        // re-muta o alvo ao receber o voiceStateUpdate gerado pelo próprio unmute.
        this.usuarios.delete(userId);
        this.desmutar(userId);
        this.ensurdecer.delete(userId);
        this.removerListenerSeOcioso();
        return { sucesso: true, tag };
    }

    limpar() {
        const total = this.usuarios.size;
        const ids = Array.from(this.usuarios.keys());
        this.usuarios.clear();
        for (const id of ids) this.desmutar(id);
        this.ensurdecer.clear();
        this.removerListener();
        return total;
    }

    // Religa o automute no client atual sem perder a lista. Usado após uma troca
    // de token (setClient(novo) apaga o listener, mas os alvos seguem na lista).
    reativar() {
        if (!this.client || this.usuarios.size === 0) return;
        this.garantirListener();
        for (const userId of this.usuarios.keys()) {
            for (const [, guild] of this.client.guilds.cache) {
                const membro = guild.members.cache.get(userId);
                if (membro?.voice?.channel) {
                    if (!membro.voice.serverMute) membro.voice.setMute(true).catch(() => {});
                    if (this.ensurdecer.has(userId) && !membro.voice.serverDeaf) {
                        membro.voice.setDeaf(true).catch(() => {});
                    }
                }
            }
        }
    }

    listar() {
        return Array.from(this.usuarios.entries()).map(([userId, tag]) => ({
            userId,
            tag,
            deafen: this.ensurdecer.has(userId)
        }));
    }

    contem(userId) {
        return this.usuarios.has(userId);
    }
}

const automuteManager = new AutomuteManager();

module.exports = { automuteManager };
