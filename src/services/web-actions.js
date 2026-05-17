/**
 * Versoes web-friendly (sem prompts CLI) das features.
 * Cada acao roda como background task do contexto do usuario.
 *
 * Cada funcao recebe { cliente, tasks } via ctx — nenhum singleton global.
 */

const { obterConfig } = require('../config/configuracao');
const { sleep } = require('../utils/sleep');
const {
    listarRelacionamentos,
    listarServidores,
    listarDMsAbertas,
    abrirDM,
    buscarTodasMensagens,
    buscarTodasMensagensParaBackup
} = require('./discord');
const { criarBackup } = require('./backup');

const RELATIONSHIP_FRIEND = 1;

function progressoBase(fase = 'iniciando', total = 0) {
    return { fase, atual: 0, total, erros: 0, iniciadoEm: Date.now() };
}

function atualizarProgresso(tasks, taskId, patch) {
    const task = tasks.getTask(taskId);
    if (!task) return;
    task.data.progress = { ...(task.data.progress || {}), ...patch };
}

function criarTaskCancelavel(tasks, nome, dataInicial = {}) {
    let cancelado = false;
    const stop = async () => {
        cancelado = true;
    };
    const taskId = tasks.addTask(nome, stop, dataInicial);
    return { taskId, isCancelado: () => cancelado };
}

function agendarRemocao(tasks, taskId, ms = 2500) {
    setTimeout(() => tasks.removeTask(taskId).catch(() => {}), ms);
}

function isValidUrl(s) {
    try { new URL(s); return true; } catch { return false; }
}

function isValidFileType(url, tipo) {
    const u = url.toLowerCase();
    switch (tipo) {
        case 'png/jpg':
            return u.includes('.png') || u.includes('.jpg') || u.includes('.jpeg');
        case 'gif':
            return u.includes('.gif');
        case 'todos':
            return u.includes('.png') || u.includes('.jpg') || u.includes('.jpeg') || u.includes('.gif');
        default:
            return false;
    }
}

function chunkArray(array, size) {
    const out = [];
    for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
    return out;
}

function obterCanalVoz(cliente, id) {
    const canal = cliente.channels.cache.get(id);
    return canal?.type === 'GUILD_VOICE' ? canal : null;
}

// ============================ AMIGOS / SERVIDORES / DMS ============================
async function removerTodosAmigosWeb(ctx) {
    const cliente = ctx.cliente;
    const amigos = listarRelacionamentos(cliente, RELATIONSHIP_FRIEND);
    if (amigos.length === 0) return { sucesso: false, mensagem: 'Você não tem amigos.' };

    const { taskId, isCancelado } = criarTaskCancelavel(ctx.tasks, 'Removendo amigos', {
        progress: progressoBase('removendo', amigos.length)
    });
    const delay = parseFloat(obterConfig().delay) || 1;

    (async () => {
        let ok = 0, erros = 0;
        try {
            for (const id of amigos) {
                if (isCancelado()) break;
                await sleep(delay);
                try {
                    await cliente.api.users['@me'].relationships[id].delete({ DiscordContext: { location: 'ContextMenu' } });
                    ok++;
                } catch { erros++; }
                atualizarProgresso(ctx.tasks, taskId, { atual: ok, erros });
            }
        } finally {
            atualizarProgresso(ctx.tasks, taskId, { fase: 'concluido', atual: ok, erros });
            agendarRemocao(ctx.tasks, taskId);
        }
    })();
    return { sucesso: true, taskId, total: amigos.length };
}

async function removerTodosServidoresWeb(ctx) {
    const cliente = ctx.cliente;
    const servidores = listarServidores(cliente);
    if (servidores.length === 0) return { sucesso: false, mensagem: 'Você não está em nenhum servidor.' };

    const { taskId, isCancelado } = criarTaskCancelavel(ctx.tasks, 'Saindo de servidores', {
        progress: progressoBase('saindo', servidores.length)
    });
    const delay = parseFloat(obterConfig().delay) || 1;

    (async () => {
        let ok = 0, erros = 0;
        try {
            for (const s of servidores) {
                if (isCancelado()) break;
                await sleep(delay);
                try { await s.leave(); ok++; } catch { erros++; }
                atualizarProgresso(ctx.tasks, taskId, { atual: ok, erros });
            }
        } finally {
            atualizarProgresso(ctx.tasks, taskId, { fase: 'concluido', atual: ok, erros });
            agendarRemocao(ctx.tasks, taskId);
        }
    })();
    return { sucesso: true, taskId, total: servidores.length };
}

async function fecharTodasDMsWeb(ctx) {
    const cliente = ctx.cliente;
    const dms = listarDMsAbertas(cliente);
    if (dms.length === 0) return { sucesso: false, mensagem: 'Você não tem DMs abertas.' };

    const { taskId, isCancelado } = criarTaskCancelavel(ctx.tasks, 'Fechando DMs', {
        progress: progressoBase('fechando', dms.length)
    });

    (async () => {
        let ok = 0, erros = 0;
        try {
            for (const dm of dms) {
                if (isCancelado()) break;
                await sleep(0.5);
                try { await dm.delete(); ok++; } catch { erros++; }
                atualizarProgresso(ctx.tasks, taskId, { atual: ok, erros });
            }
        } finally {
            atualizarProgresso(ctx.tasks, taskId, { fase: 'concluido', atual: ok, erros });
            agendarRemocao(ctx.tasks, taskId);
        }
    })();
    return { sucesso: true, taskId, total: dms.length };
}

// ============================ LIMPAR DM ============================
async function limparDMUnicaWeb(ctx, opts) {
    const cliente = ctx.cliente;
    const userId = String(opts.userId || '').trim();
    if (!userId) return { sucesso: false, mensagem: 'ID obrigatório.' };
    const fazerBackup = !!opts.fazerBackup;
    const baixarAnexos = !!opts.baixarAnexos;

    let canal = cliente.channels.cache.get(userId);
    let nomeUsuario, idCanalUsuario;
    if (!canal) {
        const u = await cliente.users.fetch(userId).catch(() => null);
        if (!u) return { sucesso: false, mensagem: 'ID inválido.' };
        nomeUsuario = u.globalName || u.username;
        idCanalUsuario = u.id;
        canal = await abrirDM(cliente, userId);
        if (!canal) return { sucesso: false, mensagem: 'Não foi possível abrir DM.' };
    } else {
        nomeUsuario = canal.recipient?.globalName || canal.recipient?.username || canal.name;
        idCanalUsuario = canal.recipient?.id || canal.id;
    }

    const { taskId, isCancelado } = criarTaskCancelavel(ctx.tasks, `Limpando DM: ${nomeUsuario}`, {
        progress: progressoBase('buscando', 0),
        usuario: nomeUsuario
    });
    const delay = parseFloat(obterConfig().delay) || 1;

    (async () => {
        let contador = 0, erros = 0;
        try {
            if (fazerBackup) {
                atualizarProgresso(ctx.tasks, taskId, { fase: 'backup-coletando' });
                const todas = await buscarTodasMensagensParaBackup(cliente, canal.id, (n) =>
                    atualizarProgresso(ctx.tasks, taskId, { atual: n })
                );
                if (todas.length > 0) {
                    atualizarProgresso(ctx.tasks, taskId, { fase: 'backup-gerando', atual: todas.length, total: todas.length });
                    try { await criarBackup(todas, nomeUsuario, idCanalUsuario, 'verde', false, baixarAnexos); }
                    catch (e) { atualizarProgresso(ctx.tasks, taskId, { erroBackup: e.message }); }
                }
            }
            atualizarProgresso(ctx.tasks, taskId, { fase: 'buscando', atual: 0, total: 0 });
            const mensagens = await buscarTodasMensagens(cliente, canal.id, (totalB, totalF) =>
                atualizarProgresso(ctx.tasks, taskId, { atual: totalF, total: totalF, encontradas: totalB })
            );
            const total = mensagens.length;
            atualizarProgresso(ctx.tasks, taskId, { fase: 'apagando', atual: 0, total });
            if (total === 0) return;
            for (const msg of mensagens) {
                if (isCancelado()) break;
                await sleep(delay);
                try { await msg.delete(); contador++; } catch { erros++; }
                atualizarProgresso(ctx.tasks, taskId, { atual: contador, total, erros });
            }
        } finally {
            atualizarProgresso(ctx.tasks, taskId, { fase: 'concluido', atual: contador, erros });
            agendarRemocao(ctx.tasks, taskId, 3000);
        }
    })();
    return { sucesso: true, taskId, usuario: nomeUsuario };
}

async function limparDMsAbertasWeb(ctx, opts) {
    const cliente = ctx.cliente;
    const fazerBackup = !!opts.fazerBackup;
    const baixarAnexos = !!opts.baixarAnexos;
    const fecharApos = !!opts.fecharApos;

    const dms = listarDMsAbertas(cliente);
    if (dms.length === 0) return { sucesso: false, mensagem: 'Você não tem DMs abertas.' };

    const { taskId, isCancelado } = criarTaskCancelavel(ctx.tasks, 'Limpando DMs abertas', {
        progress: { ...progressoBase('iniciando', dms.length), dmAtual: 0 }
    });
    const delay = parseFloat(obterConfig().delay) || 1;

    (async () => {
        let totalApagadas = 0;
        try {
            for (let i = 0; i < dms.length; i++) {
                if (isCancelado()) break;
                const dm = dms[i];
                const nome = dm.recipient?.globalName || dm.recipient?.username || dm.id;
                atualizarProgresso(ctx.tasks, taskId, {
                    fase: 'processando', dmAtual: i + 1, total: dms.length, atual: i, usuarioAtual: nome
                });
                if (fazerBackup) {
                    const todas = await buscarTodasMensagensParaBackup(cliente, dm.id);
                    if (todas.length > 0) {
                        try { await criarBackup(todas, nome, dm.recipient?.id || dm.id, 'verde', false, baixarAnexos); } catch {}
                    }
                }
                const mensagens = await buscarTodasMensagens(cliente, dm.id);
                for (const msg of mensagens) {
                    if (isCancelado()) break;
                    await sleep(delay);
                    try { await msg.delete(); totalApagadas++; } catch {}
                    atualizarProgresso(ctx.tasks, taskId, { mensagensApagadas: totalApagadas });
                }
                if (fecharApos) await dm.delete().catch(() => {});
            }
        } finally {
            atualizarProgresso(ctx.tasks, taskId, { fase: 'concluido', mensagensApagadas: totalApagadas });
            agendarRemocao(ctx.tasks, taskId, 3000);
        }
    })();
    return { sucesso: true, taskId, totalDMs: dms.length };
}

async function backupDMWeb(ctx, opts) {
    const cliente = ctx.cliente;
    const userId = String(opts.userId || '').trim();
    if (!userId) return { sucesso: false, mensagem: 'ID obrigatório.' };
    const baixarAnexos = !!opts.baixarAnexos;

    let canal = cliente.channels.cache.get(userId);
    let nomeUsuario, idCanalUsuario;
    if (!canal) {
        const u = await cliente.users.fetch(userId).catch(() => null);
        if (!u) return { sucesso: false, mensagem: 'ID inválido.' };
        nomeUsuario = u.globalName || u.username;
        idCanalUsuario = u.id;
        canal = await abrirDM(cliente, userId);
        if (!canal) return { sucesso: false, mensagem: 'Não foi possível abrir DM.' };
    } else {
        nomeUsuario = canal.recipient?.globalName || canal.recipient?.username || canal.name;
        idCanalUsuario = canal.recipient?.id || canal.id;
    }

    const { taskId, isCancelado } = criarTaskCancelavel(ctx.tasks, `Backup: ${nomeUsuario}`, {
        progress: progressoBase('buscando', 0),
        usuario: nomeUsuario
    });

    (async () => {
        try {
            const todas = await buscarTodasMensagensParaBackup(cliente, canal.id, (n) => {
                if (isCancelado()) return;
                atualizarProgresso(ctx.tasks, taskId, { atual: n });
            });
            if (isCancelado()) return;
            atualizarProgresso(ctx.tasks, taskId, { fase: 'gerando', atual: todas.length, total: todas.length });
            if (todas.length === 0) { atualizarProgresso(ctx.tasks, taskId, { fase: 'sem-mensagens' }); return; }
            const caminho = await criarBackup(todas, nomeUsuario, idCanalUsuario, 'verde', false, baixarAnexos);
            atualizarProgresso(ctx.tasks, taskId, { fase: 'concluido', caminho });
        } catch (e) {
            atualizarProgresso(ctx.tasks, taskId, { fase: 'erro', mensagem: e.message });
        } finally {
            agendarRemocao(ctx.tasks, taskId, 4000);
        }
    })();
    return { sucesso: true, taskId, usuario: nomeUsuario };
}

// ============================ SCRAPER ============================
async function scraperIconsWeb(ctx, opts) {
    const cliente = ctx.cliente;
    const canalOrigemId = String(opts.canalOrigem || '').trim();
    const tipoArquivo = opts.tipoArquivo;
    const metodo = opts.metodo;
    const webhookUrl = String(opts.webhookUrl || '').trim();
    const canalDestinoId = String(opts.canalDestino || '').trim();
    const qtdPorMensagem = parseInt(opts.qtdPorMensagem) || 5;
    const delay = parseFloat(opts.delay) || (parseFloat(obterConfig().delay) || 1);

    if (!canalOrigemId) return { sucesso: false, mensagem: 'Canal de origem obrigatório.' };
    if (!['png/jpg', 'gif', 'todos'].includes(tipoArquivo)) return { sucesso: false, mensagem: 'Tipo inválido.' };
    if (!['webhook', 'conta'].includes(metodo)) return { sucesso: false, mensagem: 'Método inválido.' };
    if (qtdPorMensagem < 1 || qtdPorMensagem > 10) return { sucesso: false, mensagem: 'qtdPorMensagem deve ser 1-10.' };

    const canalOrigem = cliente.channels.cache.get(canalOrigemId);
    if (!canalOrigem) return { sucesso: false, mensagem: 'Canal de origem não encontrado.' };

    let canalDestino = null;
    if (metodo === 'webhook') {
        if (!isValidUrl(webhookUrl) || !webhookUrl.includes('discord.com/api/webhooks/')) {
            return { sucesso: false, mensagem: 'URL de webhook inválida.' };
        }
    } else {
        canalDestino = cliente.channels.cache.get(canalDestinoId);
        if (!canalDestino) return { sucesso: false, mensagem: 'Canal de destino não encontrado.' };
    }

    const { taskId, isCancelado } = criarTaskCancelavel(ctx.tasks, 'Scraper de Icons', {
        progress: progressoBase('coletando', 0)
    });

    (async () => {
        try {
            let ultimoId = null;
            const todasUrls = [];
            while (true) {
                if (isCancelado()) break;
                const fetched = await canalOrigem.messages.fetch({ limit: 100, ...(ultimoId && { before: ultimoId }) });
                if (fetched.size === 0) break;
                for (const msg of fetched.values()) {
                    if (msg.attachments.size > 0) {
                        for (const att of msg.attachments.values()) {
                            if (isValidFileType(att.url, tipoArquivo)) todasUrls.push(att.url);
                        }
                    }
                }
                ultimoId = fetched.lastKey();
                atualizarProgresso(ctx.tasks, taskId, { atual: todasUrls.length });
                await sleep(0.5);
            }
            if (todasUrls.length === 0) { atualizarProgresso(ctx.tasks, taskId, { fase: 'sem-imagens' }); return; }

            const chunks = chunkArray(todasUrls, qtdPorMensagem);
            atualizarProgresso(ctx.tasks, taskId, { fase: 'enviando', atual: 0, total: chunks.length, imagens: todasUrls.length });

            let enviadas = 0, erros = 0;
            for (let i = 0; i < chunks.length; i++) {
                if (isCancelado()) break;
                const chunk = chunks[i];
                try {
                    if (metodo === 'webhook') {
                        const fd = new FormData();
                        for (let j = 0; j < chunk.length; j++) {
                            const url = chunk[j];
                            const r = await fetch(url);
                            const ab = await r.arrayBuffer();
                            const ext = url.split('.').pop().split('?')[0];
                            fd.append(`file${j}`, new Blob([ab]), `image${j}.${ext}`);
                        }
                        const resp = await fetch(webhookUrl, { method: 'POST', body: fd });
                        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    } else {
                        await canalDestino.send({ files: chunk });
                    }
                    enviadas += chunk.length;
                } catch { erros += chunk.length; }
                atualizarProgresso(ctx.tasks, taskId, { atual: i + 1, enviadas, erros });
                await sleep(delay);
            }
            atualizarProgresso(ctx.tasks, taskId, { fase: 'concluido', enviadas, erros });
        } catch (e) {
            atualizarProgresso(ctx.tasks, taskId, { fase: 'erro', mensagem: e.message });
        } finally {
            agendarRemocao(ctx.tasks, taskId, 4000);
        }
    })();
    return { sucesso: true, taskId };
}

// ============================ CALLS (sincronas) ============================
async function desconectarTodosCallWeb(ctx, opts) {
    const canal = obterCanalVoz(ctx.cliente, String(opts.callId || '').trim());
    if (!canal) return { sucesso: false, mensagem: 'Canal de voz inválido.' };
    if (!canal.members.size) return { sucesso: false, mensagem: 'A call está vazia.' };
    let ok = 0, fail = 0;
    for (const m of canal.members.values()) {
        try { await m.voice.setChannel(null); ok++; }
        catch (e) {
            fail++;
            if (e.message === 'Missing Permissions') return { sucesso: false, mensagem: 'Sem permissão.' };
        }
    }
    return { sucesso: true, desconectados: ok, falhas: fail };
}

async function moverMembrosCallWeb(ctx, opts) {
    const cliente = ctx.cliente;
    const origem = obterCanalVoz(cliente, String(opts.origem || '').trim());
    const destino = obterCanalVoz(cliente, String(opts.destino || '').trim());
    if (!origem || !destino) return { sucesso: false, mensagem: 'IDs de call inválidos.' };
    if (!origem.members.size) return { sucesso: false, mensagem: 'Call de origem vazia.' };
    if (destino.locked || destino.full) return { sucesso: false, mensagem: 'Call destino lotada/privada.' };
    let movidos = 0;
    for (const m of origem.members.values()) {
        try {
            await m.voice.setChannel(destino.id);
            if (m.id !== cliente.user.id) movidos++;
        } catch (e) {
            if (e.message === 'Missing Permissions') return { sucesso: false, mensagem: 'Sem permissão.' };
        }
    }
    return { sucesso: true, movidos };
}

async function mutarTodosCallWeb(ctx, opts) {
    const canal = obterCanalVoz(ctx.cliente, String(opts.callId || '').trim());
    if (!canal) return { sucesso: false, mensagem: 'Canal inválido.' };
    if (!canal.members.size) return { sucesso: false, mensagem: 'Call vazia.' };
    const mutar = opts.acao !== 'desmutar';
    let afetados = 0;
    for (const m of canal.members.values()) {
        try { await m.voice.setMute(mutar); afetados++; }
        catch (e) { if (e.message === 'Missing Permissions') return { sucesso: false, mensagem: 'Sem permissão.' }; }
    }
    return { sucesso: true, afetados, acao: mutar ? 'mutar' : 'desmutar' };
}

async function ensurdecerTodosCallWeb(ctx, opts) {
    const canal = obterCanalVoz(ctx.cliente, String(opts.callId || '').trim());
    if (!canal) return { sucesso: false, mensagem: 'Canal inválido.' };
    if (!canal.members.size) return { sucesso: false, mensagem: 'Call vazia.' };
    const ensurdecer = opts.acao !== 'desensurdecer';
    let afetados = 0;
    for (const m of canal.members.values()) {
        try { await m.voice.setDeaf(ensurdecer); afetados++; }
        catch (e) { if (e.message === 'Missing Permissions') return { sucesso: false, mensagem: 'Sem permissão.' }; }
    }
    return { sucesso: true, afetados, acao: ensurdecer ? 'ensurdecer' : 'desensurdecer' };
}

function listarMembrosCallWeb(ctx, opts) {
    const canal = obterCanalVoz(ctx.cliente, String(opts.callId || '').trim());
    if (!canal) return { sucesso: false, mensagem: 'Canal inválido.' };
    const membros = Array.from(canal.members.values()).map((m) => ({
        id: m.id, tag: m.user.tag, username: m.user.username,
        mute: !!m.voice.mute, deaf: !!m.voice.deaf,
        video: !!(m.voice.streaming || m.voice.selfVideo)
    }));
    return { sucesso: true, canal: canal.name, total: membros.length, membros };
}

// ============================ CALLS (background) ============================
async function farmarHorasWeb(ctx, opts) {
    const cliente = ctx.cliente;
    let canal;
    if (opts.canalId) {
        canal = obterCanalVoz(cliente, String(opts.canalId).trim());
        if (!canal) return { sucesso: false, mensagem: 'Canal inválido.' };
    } else if (opts.guildId) {
        const guild = cliente.guilds.cache.get(String(opts.guildId).trim());
        if (!guild) return { sucesso: false, mensagem: 'Servidor inválido.' };
        const cat = opts.categoriaId ? String(opts.categoriaId).trim() : null;
        const calls = guild.channels.cache.filter((c) =>
            c.type === 'GUILD_VOICE' && c.members.size === 0 &&
            c.permissionsFor(guild.members.me).has('CONNECT') &&
            (!cat || c.parentId === cat)
        );
        if (!calls.size) return { sucesso: false, mensagem: 'Nenhuma call vazia disponível.' };
        canal = calls.random();
    } else {
        return { sucesso: false, mensagem: 'Forneça canalId ou guildId.' };
    }
    if (canal.guild && !canal.permissionsFor(canal.guild.members.me).has('CONNECT')) {
        return { sucesso: false, mensagem: 'Sem permissão para entrar.' };
    }

    let connection, cancelado = false, voiceListener, iniciou = Date.now();
    const conectar = async () => {
        try {
            connection = await cliente.voice.joinChannel(canal, { selfMute: false, selfDeaf: false, selfVideo: false });
            return true;
        } catch { return false; }
    };
    if (!(await conectar())) return { sucesso: false, mensagem: 'Falha ao conectar.' };

    const stop = async () => {
        cancelado = true;
        if (voiceListener) cliente.off('voiceStateUpdate', voiceListener);
        try { await connection?.disconnect(); } catch {}
    };
    const taskId = ctx.tasks.addTask(`Farmando em: ${canal.name}`, stop, {
        canal: canal.name, guild: canal.guild?.name,
        progress: { fase: 'farmando', iniciou }
    });
    const tickInterval = setInterval(() => {
        if (cancelado) { clearInterval(tickInterval); return; }
        atualizarProgresso(ctx.tasks, taskId, { tempo: Date.now() - iniciou });
    }, 1000);
    voiceListener = async (oldState, newState) => {
        if (oldState.member.id === cliente.user.id && oldState.channelId && !newState.channelId) {
            await sleep(2);
            if (await conectar()) iniciou = Date.now();
        }
    };
    cliente.on('voiceStateUpdate', voiceListener);
    return { sucesso: true, taskId, canal: canal.name };
}

async function elevadorWeb(ctx, opts) {
    const cliente = ctx.cliente;
    const categoria = cliente.channels.cache.get(String(opts.categoriaId || '').trim());
    if (!categoria || categoria.type !== 'GUILD_CATEGORY') return { sucesso: false, mensagem: 'Categoria inválida.' };
    const canaisVoz = Array.from(
        categoria.guild.channels.cache.filter((c) => c.type === 'GUILD_VOICE' && c.parentId === categoria.id).values()
    );
    if (canaisVoz.length === 0) return { sucesso: false, mensagem: 'Sem canais de voz na categoria.' };

    const membro = await categoria.guild.members.fetch(String(opts.userId || '').trim()).catch(() => null);
    if (!membro) return { sucesso: false, mensagem: 'Usuário não encontrado.' };
    if (!membro.voice.channelId) return { sucesso: false, mensagem: 'Usuário não está em call.' };

    let cancelado = false, indice = 0, movimentos = 0;
    const stop = async () => { cancelado = true; clearInterval(intervalo); };
    const taskId = ctx.tasks.addTask(`Elevador: ${membro.user.username}`, stop, {
        usuario: membro.user.tag, progress: { fase: 'movendo', movimentos: 0 }
    });
    const intervalo = setInterval(async () => {
        if (cancelado) return;
        try {
            const m = await categoria.guild.members.fetch(membro.id);
            if (!m.voice.channelId) {
                cancelado = true; clearInterval(intervalo);
                atualizarProgresso(ctx.tasks, taskId, { fase: 'usuario-saiu' });
                return;
            }
            indice = (indice + 1) % canaisVoz.length;
            await m.voice.setChannel(canaisVoz[indice].id);
            movimentos++;
            atualizarProgresso(ctx.tasks, taskId, { movimentos, canalAtual: canaisVoz[indice].name });
        } catch (e) {
            cancelado = true; clearInterval(intervalo);
            atualizarProgresso(ctx.tasks, taskId, { fase: 'erro', mensagem: e.message });
        }
    }, 1000);
    return { sucesso: true, taskId, total: canaisVoz.length };
}

async function coleiraWeb(ctx, opts) {
    const cliente = ctx.cliente;
    const guild = cliente.guilds.cache.get(String(opts.guildId || '').trim());
    if (!guild) return { sucesso: false, mensagem: 'Servidor inválido.' };
    const ids = Array.isArray(opts.userIds) ? opts.userIds
        : String(opts.userIds || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return { sucesso: false, mensagem: 'Forneça userIds.' };

    const membros = [];
    for (const id of ids) {
        const m = await guild.members.fetch(id).catch(() => null);
        if (m) membros.push(m);
    }
    if (!membros.length) return { sucesso: false, mensagem: 'Nenhum usuário encontrado.' };

    let cancelado = false, voiceListener;
    const puxadas = {};
    membros.forEach((m) => (puxadas[m.id] = 0));
    const stop = async () => {
        cancelado = true;
        if (voiceListener) cliente.off('voiceStateUpdate', voiceListener);
    };
    const taskId = ctx.tasks.addTask(`Coleira: ${membros.map((m) => m.user.username).join(', ')}`, stop, {
        guild: guild.name, usuarios: membros.map((m) => ({ id: m.id, username: m.user.username })),
        progress: { fase: 'monitorando', totalPuxadas: 0 }
    });

    voiceListener = async (oldState, newState) => {
        if (cancelado) return;
        if (oldState.guild.id !== guild.id && newState.guild.id !== guild.id) return;
        const idsMon = membros.map((m) => m.id);
        if (idsMon.includes(newState.member.id) && oldState.channelId !== newState.channelId) {
            const meuCanal = guild.members.me.voice.channelId;
            if (meuCanal && (!newState.channelId || newState.channelId !== meuCanal)) {
                try {
                    await newState.member.voice.setChannel(meuCanal);
                    puxadas[newState.member.id]++;
                    atualizarProgresso(ctx.tasks, taskId, {
                        totalPuxadas: Object.values(puxadas).reduce((a, b) => a + b, 0), puxadas
                    });
                } catch {}
            }
        }
        if (newState.member.id === cliente.user.id && newState.channelId && newState.guild.id === guild.id) {
            for (const m of membros) {
                try {
                    const atual = await guild.members.fetch(m.id).catch(() => null);
                    if (atual && atual.voice.channelId && atual.voice.channelId !== newState.channelId) {
                        await atual.voice.setChannel(newState.channelId);
                        puxadas[m.id]++;
                    }
                } catch {}
            }
            atualizarProgresso(ctx.tasks, taskId, {
                totalPuxadas: Object.values(puxadas).reduce((a, b) => a + b, 0), puxadas
            });
        }
    };
    cliente.on('voiceStateUpdate', voiceListener);
    return { sucesso: true, taskId, alvos: membros.length };
}

async function protegerUsuarioWeb(ctx, opts) {
    const cliente = ctx.cliente;
    const guild = cliente.guilds.cache.get(String(opts.guildId || '').trim());
    if (!guild) return { sucesso: false, mensagem: 'Servidor inválido.' };
    const ids = Array.isArray(opts.userIds) ? opts.userIds
        : String(opts.userIds || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return { sucesso: false, mensagem: 'Forneça userIds.' };

    const membros = [];
    for (const id of ids) {
        const m = await guild.members.fetch(id).catch(() => null);
        if (m) membros.push(m);
    }
    if (!membros.length) return { sucesso: false, mensagem: 'Nenhum usuário encontrado.' };

    let cancelado = false, voiceListener;
    const protecoes = {};
    membros.forEach((m) => (protecoes[m.id] = 0));
    const stop = async () => { cancelado = true; if (voiceListener) cliente.off('voiceStateUpdate', voiceListener); };
    const taskId = ctx.tasks.addTask(`Proteger: ${membros.map((m) => m.user.username).join(', ')}`, stop, {
        guild: guild.name, usuarios: membros.map((m) => ({ id: m.id, username: m.user.username })),
        progress: { fase: 'monitorando', totalProtecoes: 0 }
    });

    voiceListener = async (oldState, newState) => {
        if (cancelado) return;
        if (newState.guild.id !== guild.id) return;
        const idsMon = membros.map((m) => m.id);
        if (!idsMon.includes(newState.member.id)) return;
        try {
            if (newState.mute && !oldState.mute) {
                await newState.member.voice.setMute(false);
                protecoes[newState.member.id]++;
            }
            if (newState.deaf && !oldState.deaf) {
                await newState.member.voice.setDeaf(false);
                protecoes[newState.member.id]++;
            }
            atualizarProgresso(ctx.tasks, taskId, {
                totalProtecoes: Object.values(protecoes).reduce((a, b) => a + b, 0), protecoes
            });
        } catch {}
    };
    cliente.on('voiceStateUpdate', voiceListener);
    return { sucesso: true, taskId, alvos: membros.length };
}

// ============================ ZARALHO ============================
async function nicknameBloqueadoWeb(ctx, opts) {
    const cliente = ctx.cliente;
    const guild = cliente.guilds.cache.get(String(opts.guildId || '').trim());
    if (!guild) return { sucesso: false, mensagem: 'Servidor inválido.' };
    const membro = await guild.members.fetch(String(opts.userId || '').trim()).catch(() => null);
    if (!membro) return { sucesso: false, mensagem: 'Usuário inválido.' };
    if (membro.user.bot) return { sucesso: false, mensagem: 'Não funciona em bots.' };
    if (!guild.members.me.permissions.has('MANAGE_NICKNAMES')) return { sucesso: false, mensagem: 'Sem permissão Gerenciar Apelidos.' };
    if (membro.roles.highest.position >= guild.members.me.roles.highest.position) {
        return { sucesso: false, mensagem: 'Cargo do usuário igual ou maior que o seu.' };
    }
    if (membro.id === guild.ownerId) return { sucesso: false, mensagem: 'Não funciona no dono.' };

    const nick = String(opts.nickname || '').trim();
    if (!nick) return { sucesso: false, mensagem: 'Nickname obrigatório.' };
    try { await membro.setNickname(nick); }
    catch (e) { return { sucesso: false, mensagem: `Erro: ${e.message}` }; }

    let cancelado = false, listener, intervalo, bloqueios = 0;
    const stop = async () => {
        cancelado = true;
        if (listener) cliente.off('guildMemberUpdate', listener);
        if (intervalo) clearInterval(intervalo);
    };
    const taskId = ctx.tasks.addTask(`Nick bloqueado: ${membro.user.username}`, stop, {
        usuario: membro.user.tag, nickname: nick,
        progress: { fase: 'monitorando', bloqueios: 0 }
    });
    listener = async (oldM, newM) => {
        if (cancelado) return;
        if (newM.id !== membro.id || newM.guild.id !== guild.id) return;
        if (newM.nickname !== nick) {
            try { await newM.setNickname(nick); bloqueios++; atualizarProgresso(ctx.tasks, taskId, { bloqueios }); } catch {}
        }
    };
    cliente.on('guildMemberUpdate', listener);
    intervalo = setInterval(async () => {
        if (cancelado) return;
        try {
            const atual = await guild.members.fetch(membro.id);
            if (atual.nickname !== nick) { await atual.setNickname(nick); bloqueios++; atualizarProgresso(ctx.tasks, taskId, { bloqueios }); }
        } catch {}
    }, 2000);
    return { sucesso: true, taskId };
}

async function blacklistChatWeb(ctx, opts) {
    const cliente = ctx.cliente;
    const guild = cliente.guilds.cache.get(String(opts.guildId || '').trim());
    if (!guild) return { sucesso: false, mensagem: 'Servidor inválido.' };
    const membro = await guild.members.fetch(String(opts.userId || '').trim()).catch(() => null);
    if (!membro) return { sucesso: false, mensagem: 'Usuário inválido.' };
    if (membro.user.bot) return { sucesso: false, mensagem: 'Não funciona em bots.' };
    if (!guild.members.me.permissions.has('MANAGE_MESSAGES')) return { sucesso: false, mensagem: 'Sem permissão Gerenciar Mensagens.' };

    let cancelado = false, listener, apagadas = 0;
    const stop = async () => { cancelado = true; if (listener) cliente.off('messageCreate', listener); };
    const taskId = ctx.tasks.addTask(`Blacklist: ${membro.user.username}`, stop, {
        usuario: membro.user.tag,
        progress: { fase: 'monitorando', apagadas: 0 }
    });
    listener = async (msg) => {
        if (cancelado) return;
        if (msg.author.id !== membro.id) return;
        if (msg.guild?.id !== guild.id) return;
        try {
            const perms = msg.channel.permissionsFor(guild.members.me);
            if (!perms || !perms.has('MANAGE_MESSAGES')) return;
            await msg.delete();
            apagadas++;
            atualizarProgresso(ctx.tasks, taskId, { apagadas, ultimoCanal: msg.channel.name });
        } catch {}
    };
    cliente.on('messageCreate', listener);
    return { sucesso: true, taskId };
}

async function antiDMWeb(ctx) {
    const cliente = ctx.cliente;
    let cancelado = false, listener, saidos = 0;
    const stop = async () => { cancelado = true; if (listener) cliente.off('channelCreate', listener); };
    const taskId = ctx.tasks.addTask('Anti DM', stop, { progress: { fase: 'monitorando', saidos: 0 } });
    listener = async (channel) => {
        if (cancelado) return;
        if (channel.type === 'GROUP_DM') {
            try {
                const nome = channel.name || 'Grupo sem nome';
                await channel.delete();
                saidos++;
                atualizarProgresso(ctx.tasks, taskId, { saidos, ultimoGrupo: nome });
            } catch {}
        }
    };
    cliente.on('channelCreate', listener);
    return { sucesso: true, taskId };
}

module.exports = {
    removerTodosAmigosWeb,
    removerTodosServidoresWeb,
    fecharTodasDMsWeb,
    limparDMUnicaWeb,
    limparDMsAbertasWeb,
    backupDMWeb,
    scraperIconsWeb,
    desconectarTodosCallWeb,
    moverMembrosCallWeb,
    mutarTodosCallWeb,
    ensurdecerTodosCallWeb,
    listarMembrosCallWeb,
    farmarHorasWeb,
    elevadorWeb,
    coleiraWeb,
    protegerUsuarioWeb,
    nicknameBloqueadoWeb,
    blacklistChatWeb,
    antiDMWeb
};
