/**
 * "Entrar em call": faz o self entrar/sair de um canal de voz e controla
 * mute/surdo, tudo via gateway raw (opcode 4 VOICE_STATE_UPDATE) — sem áudio
 * nem @discordjs/voice/UDP, igual ao farmar horas. A presença fica em
 * ctx.presencaCall e se reenvia sozinha se a conta cair/for movida do canal.
 */

const { sleep } = require('../utils/sleep');

function resolverCanalVoz(cliente, guildId, channelId) {
    const guild = cliente.guilds.cache.get(String(guildId));
    if (!guild) return { erro: 'Servidor inválido ou conta não é membro.' };
    const canal = guild.channels.cache.get(String(channelId));
    if (!canal) return { erro: 'Canal não encontrado.' };
    if (canal.type !== 'GUILD_VOICE' && canal.type !== 'GUILD_STAGE_VOICE') {
        return { erro: 'Canal não é de voz.' };
    }
    return { guild, canal };
}

function enviarVoiceState(guild, channelId, { mute = false, deaf = false } = {}) {
    try {
        const shard = guild.shard;
        if (!shard) return false;
        shard.send({
            op: 4,
            d: {
                guild_id: guild.id,
                channel_id: channelId,
                self_mute: !!mute,
                self_deaf: !!deaf,
                self_video: false
            }
        });
        return true;
    } catch {
        return false;
    }
}

async function entrarCall(ctx, { guildId, channelId, mute = false, deaf = false }) {
    const cliente = ctx.cliente;
    if (!cliente) return { sucesso: false, mensagem: 'Cliente não conectado.' };

    const r = resolverCanalVoz(cliente, guildId, channelId);
    if (r.erro) return { sucesso: false, mensagem: r.erro };
    const { guild, canal } = r;

    const me = guild.members.me || guild.members.cache.get(cliente.user?.id);
    if (me && canal.permissionsFor && !canal.permissionsFor(me).has('CONNECT')) {
        return { sucesso: false, mensagem: 'Sem permissão CONNECT no canal.' };
    }

    // Surdo implica mudo no Discord.
    if (deaf) mute = true;

    // Sai de uma call anterior antes de entrar na nova.
    if (ctx.presencaCall) { try { ctx.presencaCall.cleanup(); } catch {} ctx.presencaCall = null; }

    if (!enviarVoiceState(guild, canal.id, { mute, deaf })) {
        return { sucesso: false, mensagem: 'Gateway não está pronto (shard ainda conectando).' };
    }

    const estado = {
        guildId: guild.id,
        channelId: canal.id,
        canalNome: canal.name,
        guildNome: guild.name,
        mute: !!mute,
        deaf: !!deaf
    };

    let parado = false;
    let reenviando = false;
    const estouNoAlvo = () => guild.members.cache.get(cliente.user?.id)?.voice?.channelId === canal.id;

    const reenviar = async () => {
        if (parado || reenviando) return;
        reenviando = true;
        try {
            for (let i = 1; i <= 6 && !parado; i++) {
                let guard = 0;
                while (cliente.ws?.status !== 0 && !parado && guard < 30) { await sleep(2); guard++; }
                if (parado) return;
                if (enviarVoiceState(guild, canal.id, { mute: estado.mute, deaf: estado.deaf })) {
                    await sleep(3);
                    if (parado) return;
                    if (estouNoAlvo()) return;
                }
                await sleep(Math.min(30, 2 * i));
            }
        } finally {
            reenviando = false;
        }
    };

    // Saímos/fomos movidos do canal -> tenta voltar.
    const voiceListener = (oldS, newS) => {
        if (parado) return;
        const id = newS?.id || oldS?.id;
        if (id !== cliente.user?.id) return;
        if (oldS?.channelId === canal.id && newS?.channelId !== canal.id) {
            reenviar().catch(() => {});
        }
    };
    // Gateway voltou -> reenvia o estado.
    const gatewayListener = async () => {
        if (parado) return;
        await sleep(3);
        if (!parado && !estouNoAlvo()) reenviar().catch(() => {});
    };
    const health = setInterval(() => {
        if (parado) { clearInterval(health); return; }
        if (reenviando) return;
        try { if (!estouNoAlvo() && cliente.ws?.status === 0) reenviar().catch(() => {}); } catch {}
    }, 30_000);

    cliente.on('voiceStateUpdate', voiceListener);
    cliente.on('shardReady', gatewayListener);
    cliente.on('shardResume', gatewayListener);
    cliente.on('ready', gatewayListener);

    estado.cleanup = () => {
        parado = true;
        cliente.off('voiceStateUpdate', voiceListener);
        cliente.off('shardReady', gatewayListener);
        cliente.off('shardResume', gatewayListener);
        cliente.off('ready', gatewayListener);
        clearInterval(health);
        try { enviarVoiceState(guild, null); } catch {}
    };

    ctx.presencaCall = estado;
    return { sucesso: true, canal: canal.name, guild: guild.name };
}

function sairCall(ctx) {
    if (!ctx.presencaCall) return { sucesso: false, mensagem: 'Não está em call.' };
    try { ctx.presencaCall.cleanup(); } catch {}
    ctx.presencaCall = null;
    return { sucesso: true };
}

function definirEstadoCall(ctx, { mute, deaf }) {
    const p = ctx.presencaCall;
    if (!p) return { sucesso: false, mensagem: 'Não está em call.' };
    if (typeof mute === 'boolean') p.mute = mute;
    if (typeof deaf === 'boolean') p.deaf = deaf;
    if (p.deaf) p.mute = true; // surdo implica mudo
    const guild = ctx.cliente?.guilds?.cache?.get(p.guildId);
    if (!guild) return { sucesso: false, mensagem: 'Servidor indisponível.' };
    enviarVoiceState(guild, p.channelId, { mute: p.mute, deaf: p.deaf });
    return { sucesso: true, mute: p.mute, deaf: p.deaf };
}

function estadoCall(ctx) {
    const p = ctx.presencaCall;
    if (!p) return { ativa: false };
    return { ativa: true, guildId: p.guildId, channelId: p.channelId, canal: p.canalNome, guild: p.guildNome, mute: p.mute, deaf: p.deaf };
}

module.exports = { entrarCall, sairCall, definirEstadoCall, estadoCall };
