/**
 * Versoes web-friendly (sem prompts CLI) das features.
 * Cada acao roda como background task do contexto do usuario.
 *
 * Cada funcao recebe { cliente, tasks } via ctx — nenhum singleton global.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
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

const EXTENSOES_IMAGEM = ['.png', '.jpg', '.jpeg', '.webp'];
const EXTENSOES_VIDEO = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'];

function temExtensao(url, exts) {
    // Remove a query string do CDN do Discord (?ex=...&hm=...) antes de checar a extensão
    const caminho = String(url).split('?')[0].toLowerCase();
    return exts.some((ext) => caminho.endsWith(ext));
}

function isValidFileType(url, tipo) {
    switch (tipo) {
        case 'png/jpg':
            return temExtensao(url, EXTENSOES_IMAGEM);
        case 'gif':
            return temExtensao(url, ['.gif']);
        case 'video':
            return temExtensao(url, EXTENSOES_VIDEO);
        case 'todos':
            // Qualquer anexo, de qualquer tipo (imagens, vídeos, documentos, etc.)
            return true;
        default:
            return false;
    }
}

function nomeArquivoDaUrl(url, fallback) {
    try {
        const nome = decodeURIComponent(String(url).split('?')[0].split('/').pop());
        return nome && nome.length ? nome : fallback;
    } catch {
        return fallback;
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

async function removerTodosServidoresWeb(ctx, opts = {}) {
    const cliente = ctx.cliente;
    let servidores = listarServidores(cliente);
    // Se vier uma lista de IDs, sai só desses; senão, sai de todos (comportamento antigo).
    const idsSelecionados = Array.isArray(opts.guildIds)
        ? opts.guildIds.map((s) => String(s).trim()).filter(Boolean)
        : null;
    if (idsSelecionados && idsSelecionados.length) {
        const set = new Set(idsSelecionados);
        servidores = servidores.filter((s) => set.has(s.id));
        if (servidores.length === 0) return { sucesso: false, mensagem: 'Nenhum dos servidores selecionados foi encontrado.' };
    } else if (servidores.length === 0) {
        return { sucesso: false, mensagem: 'Você não está em nenhum servidor.' };
    }

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

async function fecharTodasDMsWeb(ctx, opts = {}) {
    const cliente = ctx.cliente;
    let dms = listarDMsAbertas(cliente);
    if (dms.length === 0) return { sucesso: false, mensagem: 'Você não tem DMs abertas.' };

    // Whitelist: DMs que NÃO devem ser fechadas. Aceita IDs (do usuário ou do
    // canal) e nomes/usernames/tags. Pode vir como array ou string (vírgula/linha).
    const brutos = Array.isArray(opts.whitelist)
        ? opts.whitelist
        : String(opts.whitelist || '').split(/[\n,]+/);
    const wl = new Set(
        brutos.map((s) => String(s).trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
    );
    let protegidas = 0;
    if (wl.size) {
        dms = dms.filter((dm) => {
            const r = dm.recipient;
            const chaves = [dm.id, r?.id, r?.username, r?.globalName, r?.tag]
                .filter(Boolean)
                .map((x) => String(x).toLowerCase());
            const protegida = chaves.some((k) => wl.has(k));
            if (protegida) protegidas++;
            return !protegida;
        });
        if (dms.length === 0) {
            return { sucesso: false, mensagem: `Todas as ${protegidas} DMs abertas estão na whitelist.` };
        }
    }

    const { taskId, isCancelado } = criarTaskCancelavel(ctx.tasks, 'Fechando DMs', {
        progress: progressoBase('fechando', dms.length),
        protegidas
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
    return { sucesso: true, taskId, total: dms.length, protegidas };
}

// Sai de grupos de DM específicos (escolhidos pelo usuário). Ao contrário do
// Anti DM (que só pega grupos NOVOS via channelCreate), este sai dos grupos em
// que você JÁ está agora.
async function sairGruposDMWeb(ctx, opts = {}) {
    const cliente = ctx.cliente;
    const ids = Array.isArray(opts.ids)
        ? opts.ids.map((x) => String(x).trim()).filter(Boolean)
        : String(opts.ids || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return { sucesso: false, mensagem: 'Selecione ao menos um grupo.' };

    const { taskId, isCancelado } = criarTaskCancelavel(ctx.tasks, 'Saindo de grupos', {
        progress: progressoBase('saindo', ids.length)
    });

    (async () => {
        let ok = 0, erros = 0;
        try {
            for (const id of ids) {
                if (isCancelado()) break;
                await sleep(0.6);
                try {
                    // DELETE /channels/:id em um group DM = sair do grupo.
                    await cliente.api.channels(id).delete();
                    ok++;
                } catch { erros++; }
                atualizarProgresso(ctx.tasks, taskId, { atual: ok, erros });
            }
        } finally {
            atualizarProgresso(ctx.tasks, taskId, { fase: 'concluido', atual: ok, erros });
            agendarRemocao(ctx.tasks, taskId);
        }
    })();
    return { sucesso: true, taskId, total: ids.length };
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
    if (!['png/jpg', 'gif', 'video', 'todos'].includes(tipoArquivo)) return { sucesso: false, mensagem: 'Tipo inválido.' };
    if (!['webhook', 'conta', 'salvar'].includes(metodo)) return { sucesso: false, mensagem: 'Método inválido.' };
    if (metodo !== 'salvar' && (qtdPorMensagem < 1 || qtdPorMensagem > 10)) return { sucesso: false, mensagem: 'qtdPorMensagem deve ser 1-10.' };

    const canalOrigem = cliente.channels.cache.get(canalOrigemId);
    if (!canalOrigem) return { sucesso: false, mensagem: 'Canal de origem não encontrado.' };

    let canalDestino = null;
    if (metodo === 'webhook') {
        if (!isValidUrl(webhookUrl) || !webhookUrl.includes('discord.com/api/webhooks/')) {
            return { sucesso: false, mensagem: 'URL de webhook inválida.' };
        }
    } else if (metodo === 'conta') {
        canalDestino = cliente.channels.cache.get(canalDestinoId);
        if (!canalDestino) return { sucesso: false, mensagem: 'Canal de destino não encontrado.' };
    }
    // metodo === 'salvar' não precisa de destino — baixa pro PC

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

            // ===== Método: salvar no PC =====
            if (metodo === 'salvar') {
                const pasta = path.join(os.homedir(), 'Downloads', 'pkthegoat-clear', `scraper-${canalOrigemId}`);
                fs.mkdirSync(pasta, { recursive: true });
                atualizarProgresso(ctx.tasks, taskId, { fase: 'salvando', atual: 0, total: todasUrls.length, pasta });
                let salvos = 0, errosSalvar = 0;
                for (let i = 0; i < todasUrls.length; i++) {
                    if (isCancelado()) break;
                    try {
                        const url = todasUrls[i];
                        const r = await fetch(url);
                        if (!r.ok) throw new Error(`HTTP ${r.status}`);
                        const ab = await r.arrayBuffer();
                        let nome = nomeArquivoDaUrl(url, `arquivo_${i}`);
                        let destino = path.join(pasta, nome);
                        let n = 1;
                        while (fs.existsSync(destino)) {
                            const ext = path.extname(nome);
                            const base = path.basename(nome, ext);
                            destino = path.join(pasta, `${base}_${n}${ext}`);
                            n++;
                        }
                        fs.writeFileSync(destino, Buffer.from(ab));
                        salvos++;
                    } catch { errosSalvar++; }
                    atualizarProgresso(ctx.tasks, taskId, { atual: i + 1, salvos, erros: errosSalvar });
                    await sleep(0.2);
                }
                atualizarProgresso(ctx.tasks, taskId, { fase: 'concluido', salvos, erros: errosSalvar, pasta });
                return;
            }

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

// Descobre a call de voz em que a própria conta logada está conectada agora.
function obterMinhaCallVoz(cliente) {
    const meuId = cliente?.user?.id;
    if (!meuId) return null;
    for (const guild of cliente.guilds.cache.values()) {
        const meu = guild.members.cache.get(meuId);
        if (meu?.voice?.channel) return meu.voice.channel;
    }
    return null;
}

// Lista os membros da call em que a conta está agora — sem precisar de ID.
function listarMinhaCallWeb(ctx) {
    const canal = obterMinhaCallVoz(ctx.cliente);
    if (!canal) return { sucesso: false, mensagem: 'Você não está em nenhuma call no momento.' };
    const meuId = ctx.cliente.user?.id;
    const membros = Array.from(canal.members.values()).map((m) => ({
        id: m.id, tag: m.user.tag, username: m.user.username,
        mute: !!m.voice.mute, deaf: !!m.voice.deaf,
        video: !!(m.voice.streaming || m.voice.selfVideo),
        eu: m.id === meuId
    }));
    return {
        sucesso: true,
        callId: canal.id,
        guildId: canal.guild.id,
        canal: canal.name,
        servidor: canal.guild.name,
        total: membros.length,
        membros
    };
}

// ============================ FARMAR HORAS (gateway raw) ============================
// Implementação por gateway raw: em vez de abrir conexão de voz completa (que
// requer UDP + 15s de timeout do handshake), mandamos o opcode 4
// (VOICE_STATE_UPDATE) direto na WebSocket da gateway. Discord conta o usuário
// como conectado ao canal e o tempo de voz acumula normalmente. Não há áudio
// nem necessidade de @discordjs/voice / UDP outbound.
async function farmarHorasWeb(ctx, opts) {
    const cliente = opts.clientOverride || ctx.cliente;
    const contaLabel = opts.accountLabel || cliente?.user?.tag || cliente?.user?.username || 'Conta';
    const onStopExtra = typeof opts.onStop === 'function' ? opts.onStop : null;

    // ---------- resolve guild/canal ----------
    let canal, guild;
    if (opts.canalId) {
        canal = obterCanalVoz(cliente, String(opts.canalId).trim());
        if (!canal) return { sucesso: false, mensagem: 'Canal inválido ou conta não é membro desse servidor.' };
        guild = canal.guild;
    } else if (opts.guildId) {
        guild = cliente.guilds.cache.get(String(opts.guildId).trim());
        if (!guild) return { sucesso: false, mensagem: 'Servidor inválido ou conta não é membro.' };
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
    if (!guild) return { sucesso: false, mensagem: 'Canal sem guild (DM não suportada).' };
    if (!canal.permissionsFor(guild.members.me).has('CONNECT')) {
        return { sucesso: false, mensagem: 'Sem permissão CONNECT no canal.' };
    }

    // ---------- helpers de gateway ----------
    const enviarVoiceState = (channelId) => {
        try {
            const shard = guild.shard;
            if (!shard) return false;
            // op 4 = VOICE_STATE_UPDATE
            shard.send({
                op: 4,
                d: {
                    guild_id: guild.id,
                    channel_id: channelId,
                    self_mute: false,
                    self_deaf: false,
                    self_video: false
                }
            });
            return true;
        } catch (e) {
            console.error(`[farm] sendPayload falhou (${contaLabel}):`, e.message);
            return false;
        }
    };

    const estouNoAlvo = () => {
        const meu = guild.members.cache.get(cliente.user?.id);
        return meu?.voice?.channelId === canal.id;
    };

    // ---------- envio inicial ----------
    if (!enviarVoiceState(canal.id)) {
        return { sucesso: false, mensagem: 'Gateway WebSocket não está pronto (shard ainda conectando).' };
    }

    // ---------- estado do farm ----------
    let cancelado = false;
    let iniciou = Date.now();
    let tempoAcumulado = 0;
    let farmPausado = false; // pausa automática quando você entra numa call de verdade
    let reconexoesTotais = 0;
    let reenviando = false;
    let voiceListener, gatewayListener, errorListener;
    let healthInterval, tickInterval;
    let taskId;

    // Reenvia o VOICE_STATE_UPDATE quando perdemos o canal por qualquer motivo.
    // Não há "timeout de 15s" — só mandamos o pacote e verificamos se o estado
    // foi atualizado pelo Discord (via voiceStateUpdate event).
    const reenviar = async (motivo) => {
        if (cancelado || reenviando) return;
        reenviando = true;
        try {
            for (let i = 1; i <= 6 && !cancelado; i++) {
                atualizarProgresso(ctx.tasks, taskId, {
                    fase: 'reconectando', motivo, tentativa: i
                });
                // Espera shard estar pronto antes de mandar
                let waitGuard = 0;
                while (cliente.ws?.status !== 0 && !cancelado && waitGuard < 30) {
                    await sleep(2);
                    waitGuard++;
                }
                if (cancelado) return;

                // Re-resolve canal do cache (pode ter mudado)
                const novo = cliente.channels.cache.get(canal.id);
                if (novo && novo.type === 'GUILD_VOICE') canal = novo;

                if (enviarVoiceState(canal.id)) {
                    // Pequeno respiro pro Discord propagar via voiceStateUpdate
                    await sleep(3);
                    if (cancelado) return;
                    if (estouNoAlvo()) {
                        iniciou = Date.now();
                        reconexoesTotais++;
                        atualizarProgresso(ctx.tasks, taskId, {
                            fase: 'farmando', tentativa: 0, reconexoes: reconexoesTotais
                        });
                        return;
                    }
                }
                const espera = Math.min(30, 2 * i);
                await sleep(espera);
            }
        } finally {
            reenviando = false;
        }
    };

    const stop = async () => {
        cancelado = true;
        if (voiceListener) cliente.off('voiceStateUpdate', voiceListener);
        if (gatewayListener) {
            cliente.off('shardReady', gatewayListener);
            cliente.off('shardResume', gatewayListener);
            cliente.off('ready', gatewayListener);
        }
        if (errorListener) {
            cliente.off('shardDisconnect', errorListener);
            cliente.off('shardError', errorListener);
        }
        if (healthInterval) clearInterval(healthInterval);
        if (tickInterval) clearInterval(tickInterval);
        // Sai do canal mandando channel_id=null
        try { enviarVoiceState(null); } catch {}
        if (onStopExtra) { try { await onStopExtra(); } catch {} }
    };

    taskId = ctx.tasks.addTask(`Farmando em: ${canal.name} · ${contaLabel}`, stop, {
        canal: canal.name, guild: guild.name, conta: contaLabel,
        progress: { fase: 'farmando', iniciou, reconexoes: 0 }
    });

    tickInterval = setInterval(() => {
        if (cancelado) { clearInterval(tickInterval); return; }
        if (farmPausado) return; // congela o cronômetro enquanto você está em call
        atualizarProgresso(ctx.tasks, taskId, { tempo: tempoAcumulado + (Date.now() - iniciou) });
    }, 1000);

    // (1) voiceStateUpdate da própria conta — saímos / fomos movidos
    voiceListener = async (oldState, newState) => {
        if (cancelado) return;
        const meuId = cliente.user?.id;
        const idDoEvento = newState?.id || oldState?.id;
        if (idDoEvento !== meuId) return;
        const estavaNoAlvo = oldState?.channelId === canal.id;
        const aindaNoAlvo = newState?.channelId === canal.id;

        if (!farmPausado) {
            // Você entrou / foi movido para OUTRA call (≠ canal de farm) -> pausa o farm.
            // Não reenviamos: você continua na call em que entrou.
            if (estavaNoAlvo && !aindaNoAlvo && newState?.channelId) {
                farmPausado = true;
                tempoAcumulado += Date.now() - iniciou;
                atualizarProgresso(ctx.tasks, taskId, { fase: 'pausado-em-call', tempo: tempoAcumulado });
                return;
            }
            // Saímos do canal de farm SEM entrar em outra call -> continua farmando (reconecta).
            if (estavaNoAlvo && !aindaNoAlvo && !newState?.channelId) {
                await sleep(1);
                if (cancelado || farmPausado) return;
                reenviar('desconectado').catch(() => {});
            }
        } else {
            // Farm pausado: você saiu da call (não está em nenhuma) -> retoma o farm.
            if (!newState?.channelId) {
                await sleep(1);
                if (cancelado || !farmPausado) return;
                farmPausado = false;
                iniciou = Date.now();
                atualizarProgresso(ctx.tasks, taskId, { fase: 'farmando' });
                reenviar('retomando').catch(() => {});
            }
        }
    };
    cliente.on('voiceStateUpdate', voiceListener);

    // (2) Gateway voltou — reenviar o estado (mas não se o farm estiver pausado)
    gatewayListener = async () => {
        if (cancelado || farmPausado) return;
        await sleep(3);
        if (cancelado || farmPausado) return;
        if (!estouNoAlvo()) reenviar('gateway-reconectou').catch(() => {});
    };
    cliente.on('shardReady', gatewayListener);
    cliente.on('shardResume', gatewayListener);
    cliente.on('ready', gatewayListener);

    // (3) Gateway caiu — apenas marca na UI
    errorListener = () => {
        if (cancelado) return;
        atualizarProgresso(ctx.tasks, taskId, { fase: 'gateway-offline' });
    };
    cliente.on('shardDisconnect', errorListener);
    cliente.on('shardError', errorListener);

    // (4) Health check periódico — fallback se algum evento for perdido
    healthInterval = setInterval(() => {
        if (cancelado) { clearInterval(healthInterval); return; }
        if (reenviando || farmPausado) return;
        try {
            if (!estouNoAlvo() && cliente.ws?.status === 0) {
                reenviar('health-check').catch(() => {});
            }
        } catch {}
    }, 30_000);

    return { sucesso: true, taskId, canal: canal.name, conta: contaLabel };
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

// Protege a PRÓPRIA conta: remove server-mute/deaf de você mesmo, mas com atraso
// aleatório (jitter) e um cooldown entre correções. Isso evita o padrão de
// "mass unmute" instantâneo que muitos anti-nukes detectam e punem removendo
// cargos. opts: { guildId? (escopo; vazio = todos os servidores),
//                  delayMin?, delayMax? (ms do jitter), cooldown? (ms mínimos entre correções) }
// Modo "hit": em vez de desmutar com o próprio token (que dispara anti-nuke de
// mass-unmute removendo cargos), clica no botão "seja desmutado" de uma mensagem
// de bot. Precisa do canal + mensagem onde o botão está.
function _arr(x) {
    return Array.isArray(x) ? x : (x && typeof x.values === 'function' ? Array.from(x.values()) : []);
}

// A mensagem usa Components V2 (containers/sections aninhados). Percorre a árvore
// recursivamente e coleta os BOTÕES (type 2) com custom_id, lendo via toJSON.
function _coletarBotoes(msg) {
    const botoes = [];
    const visitar = (node, depth) => {
        if (!node || depth > 8) return;
        let j = node;
        try { if (typeof node.toJSON === 'function') j = node.toJSON(); } catch (e) {}
        const tipo = (j && j.type != null) ? j.type : node.type;
        if (tipo === 2) { // Button
            botoes.push({
                ref: node,
                label: String((j && j.label) || node.label || (j && j.emoji && j.emoji.name) || ''),
                customId: (j && (j.custom_id || j.customId)) || node.customId || node.custom_id || null,
                style: (j && j.style != null) ? j.style : node.style,
                url: (j && j.url) || node.url || null,
            });
        }
        for (const k of _arr((j && j.components) || node.components)) visitar(k, depth + 1);
        const acc = (j && j.accessory) || node.accessory;
        if (acc) visitar(acc, depth + 1);
    };
    for (const top of _arr(msg.components)) visitar(top, 0);
    return botoes;
}

async function clicarBotaoDesmuteHit(cliente, canalId, messageId, alvoBotao) {
    const canal = await cliente.channels.fetch(canalId).catch(() => null);
    if (!canal || !canal.messages || typeof canal.messages.fetch !== 'function') {
        throw new Error('canal hit inacessível');
    }
    let msg;
    try { msg = await canal.messages.fetch(messageId); } catch (e) { throw new Error('fetch msg: ' + (e && e.message)); }
    if (!msg) throw new Error('mensagem hit não encontrada');
    if (typeof msg.clickButton !== 'function') throw new Error('lib sem suporte a clicar botão');

    const botoes = _coletarBotoes(msg).filter((b) => b.customId && b.style !== 5); // ignora link
    const termo = String(alvoBotao || 'desmut').toLowerCase();
    let alvo = botoes.find((b) => b.label.toLowerCase().includes(termo) || String(b.customId || '').toLowerCase().includes(termo));
    if (!alvo) alvo = botoes[0];

    const resumo = () => (botoes.length
        ? botoes.map((b) => `[${b.label || 's/label'}|id=${b.customId}|st=${b.style}]`).join(' ')
        : '(nenhum botao acionavel)');

    if (!alvo) throw new Error('botao nao encontrado. botoes: ' + resumo());

    try {
        await msg.clickButton(alvo.customId);
    } catch (e) {
        throw new Error(`falha clique: ${e && e.message} | alvo="${alvo.label}" id="${alvo.customId}" | botoes: ${resumo()}`);
    }
    return true;
}

async function protegerMeuWeb(ctx, opts = {}) {
    const cliente = ctx.cliente;
    const meuId = cliente.user?.id;
    if (!meuId) return { sucesso: false, mensagem: 'Conta não identificada.' };
    const guildId = opts.guildId ? String(opts.guildId).trim() : null;
    if (guildId && !cliente.guilds.cache.get(guildId)) {
        return { sucesso: false, mensagem: 'Servidor inválido ou conta não é membro.' };
    }

    // Modo "hit": clica um botão de bot em vez de usar o token.
    const modoHit = String(opts.modo || '').toLowerCase() === 'hit';
    const hitCanalId = String(opts.hitCanalId || '').trim();
    const hitMessageId = String(opts.hitMessageId || '').trim();
    const hitBotao = String(opts.hitBotao || 'desmut');
    if (modoHit && (!hitCanalId || !hitMessageId)) {
        return { sucesso: false, mensagem: 'Modo HIT exige o ID do canal e o ID da mensagem do botão.' };
    }

    // No modo token os atrasos defendem contra o anti-nuke de mass-unmute. No modo
    // HIT (clica um botão de bot) isso não se aplica, então fica quase instantâneo.
    const delayMin = Math.max(0, Number(opts.delayMin) || (modoHit ? 0 : 300));
    const delayMax = modoHit
        ? Math.max(delayMin, Number(opts.delayMax) || 25)
        : Math.max(delayMin + 100, Number(opts.delayMax) || 900);
    const cooldown = Math.max(0, Number(opts.cooldown) || (modoHit ? 0 : 900));
    const jitter = () => delayMin + Math.floor(Math.random() * (delayMax - delayMin + 1));

    // HIT: resolve e cacheia a mensagem + customId do botão UMA vez. Assim cada
    // desmute é só um clique (POST), sem refazer o fetch da mensagem a cada vez —
    // crucial pra ganhar a "guerra de mute" contra um auto-mute.
    let hitMsgRef = null, hitCustomId = null;
    async function resolverHitAlvo() {
        const canal = await cliente.channels.fetch(hitCanalId).catch(() => null);
        if (!canal || !canal.messages || typeof canal.messages.fetch !== 'function') throw new Error('canal hit inacessível');
        let msg;
        try { msg = await canal.messages.fetch(hitMessageId); } catch (e) { throw new Error('fetch msg: ' + (e && e.message)); }
        if (!msg) throw new Error('mensagem hit não encontrada');
        if (typeof msg.clickButton !== 'function') throw new Error('lib sem suporte a clicar botão');
        const botoes = _coletarBotoes(msg).filter((b) => b.customId && b.style !== 5);
        const termo = String(hitBotao || 'desmut').toLowerCase();
        const alvo = botoes.find((b) => b.label.toLowerCase().includes(termo) || String(b.customId || '').toLowerCase().includes(termo)) || botoes[0];
        if (!alvo) throw new Error('botao nao encontrado: ' + (botoes.map((b) => b.label || b.customId).join(',') || 'nenhum'));
        hitMsgRef = msg; hitCustomId = alvo.customId;
    }
    async function cliqueHitRapido() {
        if (!hitMsgRef || !hitCustomId) await resolverHitAlvo();
        try { await hitMsgRef.clickButton(hitCustomId); }
        catch (e) { hitMsgRef = null; hitCustomId = null; throw e; } // invalida o cache p/ re-resolver
    }
    if (modoHit) resolverHitAlvo().catch(() => {}); // pré-aquece: a 1ª desmute já sai rápida

    let cancelado = false;
    let voiceListener;
    let agendado = false;
    let ultimoAjuste = 0;
    let correcoes = 0;
    const timers = new Set();

    // Backoff adaptativo: se te mutarem várias vezes em sequência (mute war),
    // aumenta o atraso progressivamente para não bater no anti-nuke. Em uso
    // normal (mute esporádico) o atraso extra é zero, então fica rápido.
    const historico = []; // timestamps das correções recentes
    const JANELA_MS = 15000;
    const LIMITE_RAJADA = 3;     // até 3 correções em 15s = sem penalidade
    const PASSO_BACKOFF = 900;   // ms extras por correção acima do limite
    const TETO_BACKOFF = 8000;   // teto do atraso extra
    const backoffExtra = () => {
        if (modoHit) return 0; // HIT clica botão de bot; sem risco de anti-nuke
        const agora = Date.now();
        while (historico.length && agora - historico[0] > JANELA_MS) historico.shift();
        const excedente = historico.length - LIMITE_RAJADA;
        return excedente > 0 ? Math.min(excedente * PASSO_BACKOFF, TETO_BACKOFF) : 0;
    };

    const corrigir = async () => {
        const guilds = guildId ? [cliente.guilds.cache.get(guildId)] : Array.from(cliente.guilds.cache.values());
        let mexeu = false;
        const estouMutado = guilds.some((g) => {
            const vs = g && g.members.cache.get(meuId)?.voice;
            return vs && vs.channelId && (vs.serverMute || vs.serverDeaf);
        });
        if (modoHit) {
            // Só clica o botão se eu realmente estiver mutado/ensurdecido em algum servidor do escopo.
            if (estouMutado) {
                try { await cliqueHitRapido(); correcoes++; mexeu = true; }
                catch (e) { atualizarProgresso(ctx.tasks, taskId, { erro: e.message }); }
            }
        } else {
            for (const g of guilds) {
                if (!g) continue;
                const vs = g.members.cache.get(meuId)?.voice;
                if (!vs || !vs.channelId) continue;
                try {
                    if (vs.serverMute) { await vs.setMute(false); correcoes++; mexeu = true; }
                    if (vs.serverDeaf) { await vs.setDeaf(false); correcoes++; mexeu = true; }
                } catch {}
            }
        }
        ultimoAjuste = Date.now();
        if (mexeu) historico.push(ultimoAjuste);
        atualizarProgresso(ctx.tasks, taskId, { correcoes });
    };

    const agendarCorrecao = () => {
        if (cancelado || agendado) return;
        agendado = true;
        const desde = Date.now() - ultimoAjuste;
        const esperaCooldown = desde < cooldown ? (cooldown - desde) : 0;
        const espera = esperaCooldown + jitter() + backoffExtra();
        const t = setTimeout(async () => {
            timers.delete(t);
            agendado = false;
            if (cancelado) return;
            await corrigir();
        }, espera);
        timers.add(t);
    };

    const stop = async () => {
        cancelado = true;
        if (voiceListener) cliente.off('voiceStateUpdate', voiceListener);
        for (const t of timers) clearTimeout(t);
        timers.clear();
    };
    const taskId = ctx.tasks.addTask(`Me proteger (${modoHit ? 'hit/botão' : 'auto-desmute'})`, stop, {
        escopo: guildId ? cliente.guilds.cache.get(guildId).name : 'Todos os servidores',
        modo: modoHit ? 'hit (botão)' : 'token',
        progress: { fase: 'monitorando', correcoes: 0 }
    });

    voiceListener = (oldState, newState) => {
        if (cancelado) return;
        if (newState.id !== meuId) return;
        if (guildId && newState.guild.id !== guildId) return;
        const virouMute = (newState.serverMute && !oldState.serverMute) || (newState.serverDeaf && !oldState.serverDeaf);
        if (virouMute) agendarCorrecao();
    };
    cliente.on('voiceStateUpdate', voiceListener);

    // Se já estiver mutado neste momento, agenda a primeira correção.
    agendarCorrecao();

    return { sucesso: true, taskId };
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

function _splitGraphemes(s) {
    s = String(s || '').trim();
    if (!s) return [];
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        try {
            const seg = new Intl.Segmenter('und', { granularity: 'grapheme' });
            return [...seg.segment(s)].map(x => x.segment.trim()).filter(Boolean);
        } catch {}
    }
    return s.split(/\s+/).filter(Boolean);
}

function _parsearEmojis(input) {
    const out = [];
    const customRegex = /<a?:\w+:\d+>/g;
    let lastIndex = 0, m;
    while ((m = customRegex.exec(input)) !== null) {
        const before = input.slice(lastIndex, m.index);
        if (before.trim()) out.push(..._splitGraphemes(before));
        out.push(m[0]);
        lastIndex = m.index + m[0].length;
    }
    const tail = input.slice(lastIndex);
    if (tail.trim()) out.push(..._splitGraphemes(tail));
    return out;
}

async function autoReagirWeb(ctx, opts) {
    const cliente = ctx.cliente;
    const userId = String(opts.userId || '').trim();
    const emojiInput = String(opts.emoji || '').trim();
    if (!userId) return { sucesso: false, mensagem: 'userId obrigatório.' };
    if (!emojiInput) return { sucesso: false, mensagem: 'Emoji obrigatório.' };

    const usuario = await cliente.users.fetch(userId).catch(() => null);
    if (!usuario) return { sucesso: false, mensagem: 'Usuário não encontrado.' };

    const emojis = _parsearEmojis(emojiInput);
    if (!emojis.length) return { sucesso: false, mensagem: 'Nenhum emoji válido.' };

    let cancelado = false, listener, reacoes = 0;
    const stop = async () => { cancelado = true; if (listener) cliente.off('messageCreate', listener); };
    const taskId = ctx.tasks.addTask(`Auto Reagir: ${usuario.username}`, stop, {
        usuario: usuario.tag, qtdEmojis: emojis.length,
        progress: { fase: 'monitorando', reacoes: 0 }
    });
    listener = async (msg) => {
        if (cancelado) return;
        if (msg.author.id !== userId) return;
        try {
            for (const e of emojis) {
                if (cancelado) return;
                const match = e.match(/<a?:\w+:(\d+)>/);
                const reacao = match ? match[1] : e;
                try { await msg.react(reacao); } catch {}
                await new Promise(r => setTimeout(r, 260));
            }
            reacoes++;
            const ultimoCanal = msg.guild ? `#${msg.channel.name} (${msg.guild.name})` : 'DM';
            atualizarProgresso(ctx.tasks, taskId, { reacoes, ultimoCanal });
        } catch {}
    };
    cliente.on('messageCreate', listener);
    return { sucesso: true, taskId };
}

async function listarEmojisCustomWeb(ctx) {
    const cliente = ctx.cliente;
    const out = [];
    for (const g of cliente.guilds.cache.values()) {
        const emojis = Array.from(g.emojis.cache.values()).map(e => ({
            id: e.id, name: e.name, animated: !!e.animated,
            url: e.url || `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}`
        }));
        if (emojis.length) out.push({ guildId: g.id, guildName: g.name, emojis });
    }
    return { sucesso: true, guilds: out };
}

// ============================ HYPESQUAD ============================
// Casas: 1 = Bravery (roxo), 2 = Brilliance (rosa), 3 = Balance (verde)
// Flags bitfield Discord: HYPESQUAD_ONLINE_HOUSE_1 = 64, 2 = 128, 3 = 256
const HYPESQUAD_NOMES = { 1: 'Bravery', 2: 'Brilliance', 3: 'Balance' };

function detectarHypeSquadAtual(cliente) {
    try {
        const flags = cliente?.user?.flags;
        if (!flags) return 0;
        const bits = typeof flags.bitfield === 'number' ? flags.bitfield : Number(flags);
        if (!Number.isFinite(bits)) return 0;
        if (bits & 64)  return 1;
        if (bits & 128) return 2;
        if (bits & 256) return 3;
        return 0;
    } catch {
        return 0;
    }
}

async function obterHypeSquadWeb(ctx) {
    const cliente = ctx.cliente;
    if (!cliente) return { sucesso: false, mensagem: 'Cliente não conectado' };
    const house = detectarHypeSquadAtual(cliente);
    return { sucesso: true, house, nome: HYPESQUAD_NOMES[house] || null };
}

async function mudarHypeSquadWeb(ctx, body = {}) {
    const cliente = ctx.cliente;
    if (!cliente || !cliente.user) {
        return { sucesso: false, mensagem: 'Conta Discord não conectada' };
    }

    const acao = String(body.acao || '').toLowerCase();
    const houseRaw = body.house;

    // Resolve a casa alvo (0 = remover)
    let houseId;
    if (acao === 'remover' || houseRaw === 0 || houseRaw === '0' || houseRaw === null || houseRaw === undefined) {
        houseId = 0;
    } else {
        houseId = Number(houseRaw);
        if (![1, 2, 3].includes(houseId)) {
            return { sucesso: false, mensagem: 'House inválida (use 1=Bravery, 2=Brilliance, 3=Balance)' };
        }
    }

    try {
        // Usa o REST do próprio cliente (client.user.setHypeSquad -> client.api.hypesquad.online).
        // O fetch manual anterior não enviava X-Super-Properties/User-Agent do cliente oficial,
        // então o Discord respondia 500. Pelo REST da lib os headers vão corretos.
        await cliente.user.setHypeSquad(houseId);
        if (houseId === 0) {
            return { sucesso: true, mensagem: 'Insígnia HypeSquad removida', house: 0 };
        }
        return { sucesso: true, mensagem: `Você agora é HypeSquad ${HYPESQUAD_NOMES[houseId]}`, house: houseId };
    } catch (err) {
        const status = err?.httpStatus ?? err?.status;
        const code = err?.code;
        const retry = err?.retryAfter ?? err?.retry_after;
        let mensagem = err?.message || 'Falha ao mudar HypeSquad';
        if (code === 50001 || status === 401 || status === 403) {
            mensagem = 'Sem permissão (token inválida ou expirada?)';
        } else if (err?.captcha || err?.captcha_key || /captcha/i.test(mensagem)) {
            mensagem = 'Discord exigiu captcha — não dá pra trocar HypeSquad por aqui agora';
        } else if (retry) {
            mensagem = `Muitas tentativas — espere ${retry}s e tente de novo`;
        } else if (status) {
            mensagem = `Discord retornou ${status}: ${mensagem}`;
        }
        return { sucesso: false, mensagem };
    }
}

// ======================== INSÍGNIAS & NITRO ========================
// Painel das insígnias da conta conectada. Além das que vêm das flags (que ou
// você tem ou não tem), Nitro e Boost trocam de ícone conforme os meses de
// assinatura — então dá pra mostrar quanto falta pro próximo nível.

// Níveis da insígnia de assinante Nitro, em meses de assinatura.
const NIVEIS_NITRO = [
    { meses: 1, nome: 'Bronze' },
    { meses: 3, nome: 'Prata' },
    { meses: 6, nome: 'Ouro' },
    { meses: 12, nome: 'Platina' },
    { meses: 24, nome: 'Diamante' },
    { meses: 36, nome: 'Esmeralda' },
    { meses: 60, nome: 'Rubi' },
    { meses: 72, nome: 'Opala' }
];
// Níveis da insígnia de impulsionador de servidor, em meses impulsionando.
const NIVEIS_BOOST = [1, 2, 3, 6, 9, 12, 15, 18, 24].map((meses, i) => ({
    meses,
    nome: `Nível ${i + 1}`
}));

// Ícones reais das insígnias (CDN do Discord). Os hashes abaixo foram
// conferidos um a um contra https://cdn.discordapp.com/badge-icons/<hash>.png.
// Pras insígnias que a conta TEM, o hash vem do próprio perfil (badges[]) —
// esta tabela serve pras que faltam, que o Discord não devolve.
const ICONE_BADGE = (hash) => `https://cdn.discordapp.com/badge-icons/${hash}.png`;

// Ícone do impulsionador muda a cada nível (1, 2, 3, 6, 9, 12, 15, 18, 24 meses).
const ICONES_BOOST = [
    '51040c70d4f20a921ad6674ff86fc95c',
    '0e4080d1d333bc7ad29ef6528b6f2fb7',
    '72bed924410c304dbe3d00a6e593ff59',
    'df199d2050d3ed4ebf84d64ae83989f8',
    '996b3e870e8a22ce519b3a50e6bdd52f',
    '991c9f39ee33d7537d9f408c3e53141e',
    'cb3ae83c15e970e8f3d410bc62cb8b99',
    '7142225d31238f6387d9f09efaa02759',
    'ec92202290b48d0879b7413d2dde3bab'
];

// Insígnias que vêm direto das flags públicas da conta. `badge` é o id que o
// Discord usa no perfil; `emoji` só entra se a imagem não carregar.
const INSIGNIAS_FLAG = [
    { flag: 'DISCORD_EMPLOYEE', badge: 'staff', hash: '5e74e9b61934fc1f67c65515d1f7e60d', nome: 'Staff do Discord', emoji: '🛡️' },
    { flag: 'PARTNERED_SERVER_OWNER', badge: 'partner', hash: '3f9748e53446a137a052f3454e2de41e', nome: 'Dono de servidor parceiro', emoji: '🤝' },
    { flag: 'HYPESQUAD_EVENTS', badge: 'hypesquad', hash: 'bf01d1073931f921909045f3a39fd264', nome: 'HypeSquad Events', emoji: '🎉' },
    { flag: 'HOUSE_BRAVERY', badge: 'hypesquad_house_1', hash: '8a88d63823d8a71cd5e390baa45efa02', nome: 'HypeSquad Bravery', emoji: '💜' },
    { flag: 'HOUSE_BRILLIANCE', badge: 'hypesquad_house_2', hash: '011940fd013da3f7fb926e4a1cd2e618', nome: 'HypeSquad Brilliance', emoji: '💗' },
    { flag: 'HOUSE_BALANCE', badge: 'hypesquad_house_3', hash: '3aa41de486fa12454c3761e8e223442e', nome: 'HypeSquad Balance', emoji: '💚' },
    { flag: 'BUGHUNTER_LEVEL_1', badge: 'bug_hunter_level_1', hash: '2717692c7dca7289b35297368a940dd0', nome: 'Caçador de bugs', emoji: '🐛' },
    { flag: 'BUGHUNTER_LEVEL_2', badge: 'bug_hunter_level_2', hash: '848f79194d4be5ff5f81505cbd0ce1e6', nome: 'Caçador de bugs (dourado)', emoji: '🐞' },
    { flag: 'EARLY_SUPPORTER', badge: 'early_supporter', hash: '7060786766c9c840eb3019e725d2b358', nome: 'Apoiador inicial', emoji: '🕰️' },
    { flag: 'EARLY_VERIFIED_BOT_DEVELOPER', badge: 'verified_developer', hash: '6df5892e0f35b051f8b61eace34f4967', nome: 'Dev de bot verificado', emoji: '🤖' },
    { flag: 'DISCORD_CERTIFIED_MODERATOR', badge: 'certified_moderator', hash: '6de6d34650760ba5551a79732e98ed60', nome: 'Moderador certificado', emoji: '📜' },
    { flag: 'ACTIVE_DEVELOPER', badge: 'active_developer', hash: '6bdc42827a38498929a4920da12695d9', nome: 'Desenvolvedor ativo', emoji: '⚙️' }
];

const PREMIUM_NOMES = { 0: 'Nenhum', 1: 'Nitro Classic', 2: 'Nitro', 3: 'Nitro Basic' };

// Meses completos entre duas datas (contagem de calendário, igual o Discord).
function mesesCompletos(inicio, fim) {
    let meses = (fim.getFullYear() - inicio.getFullYear()) * 12 + (fim.getMonth() - inicio.getMonth());
    if (fim.getDate() < inicio.getDate()) meses--;
    return Math.max(0, meses);
}

function somarMeses(base, meses) {
    const d = new Date(base.getTime());
    const dia = d.getDate();
    d.setMonth(d.getMonth() + meses);
    // Se o mês destino não tem o dia (31 -> fevereiro), o JS empurra pro mês
    // seguinte; puxa de volta pro último dia do mês certo.
    if (d.getDate() < dia) d.setDate(0);
    return d;
}

// Em que nível a assinatura está e quanto falta pro próximo.
function progressoAssinatura(desdeISO, niveis) {
    if (!desdeISO) return null;
    const desde = new Date(desdeISO);
    if (Number.isNaN(desde.getTime())) return null;
    const agora = new Date();
    const meses = mesesCompletos(desde, agora);

    const atual = [...niveis].reverse().find((n) => meses >= n.meses) || null;
    const proximo = niveis.find((n) => meses < n.meses) || null;

    let faltamDias = null;
    let pct = 100;
    if (proximo) {
        const alvo = somarMeses(desde, proximo.meses);
        const anterior = somarMeses(desde, atual ? atual.meses : 0);
        faltamDias = Math.max(0, Math.ceil((alvo - agora) / 86400000));
        const total = alvo - anterior;
        pct = total > 0 ? Math.min(100, Math.max(0, Math.round(((agora - anterior) / total) * 100))) : 0;
        return { desde: desde.getTime(), meses, atual, proximo, alvoEm: alvo.getTime(), faltamDias, pct };
    }
    return { desde: desde.getTime(), meses, atual, proximo: null, alvoEm: null, faltamDias: null, pct };
}

// Painel de insígnias da conta conectada: o que já tem e o progresso das que
// evoluem com o tempo (Nitro e Boost).
async function obterInsigniasWeb(ctx) {
    const cliente = ctx.cliente;
    const eu = cliente?.user;
    if (!eu) return { sucesso: false, mensagem: 'Conta Discord não conectada' };

    // O perfil traz premium_since / premium_guild_since, que é de onde sai o
    // progresso. Se falhar (rate limit, captcha), ainda mostramos as flags.
    let perfil = null;
    try {
        perfil = await eu.getProfile();
    } catch {
        // O perfil da própria conta às vezes recusa o with_mutual_guilds
        // (não existe "mútuo" consigo mesmo) — tenta a versão enxuta.
        try {
            perfil = await cliente.api.users(eu.id).profile.get({ query: { with_mutual_guilds: false } });
        } catch {}
    }

    const flags = eu.flags?.toArray?.() || [];

    // O perfil devolve as insígnias que a conta tem já com o hash do ícone —
    // é a fonte mais confiável, então ela ganha da tabela fixa.
    const doPerfil = new Map();
    for (const b of Array.isArray(perfil?.badges) ? perfil.badges : []) {
        if (b?.id) doPerfil.set(String(b.id), b);
    }
    const usados = new Set();
    const icone = (chaveBadge, hashFixo) => {
        const b = chaveBadge ? doPerfil.get(chaveBadge) : null;
        if (b?.icon) {
            usados.add(chaveBadge);
            return ICONE_BADGE(b.icon);
        }
        return hashFixo ? ICONE_BADGE(hashFixo) : null;
    };

    const insignias = INSIGNIAS_FLAG.map((i) => ({
        flag: i.flag,
        nome: i.nome,
        emoji: i.emoji,
        icone: icone(i.badge, i.hash),
        tem: flags.includes(i.flag)
    }));

    const premiumType = perfil?.premium_type ?? eu.premiumType ?? 0;
    const nitro = progressoAssinatura(perfil?.premium_since, NIVEIS_NITRO);
    const boost = progressoAssinatura(perfil?.premium_guild_since, NIVEIS_BOOST);

    // Nitro e Boost também são insígnias, mas não vêm das flags.
    insignias.push({
        flag: 'NITRO',
        nome: nitro?.atual ? `Assinante Nitro (${nitro.atual.nome})` : 'Assinante Nitro',
        emoji: '💎',
        icone: icone('premium', '2ba85e8026a8614b640c2837bcdfe21b'),
        tem: premiumType > 0 || !!nitro
    });
    // Sem boost, mostra o ícone do nível 1 (apagado) como "o que dá pra ganhar".
    const nivelBoost = boost?.atual ? NIVEIS_BOOST.findIndex((n) => n.meses === boost.atual.meses) : -1;
    insignias.push({
        flag: 'BOOST',
        nome: boost?.atual ? `Impulsionador (${boost.atual.nome})` : 'Impulsionador de servidor',
        emoji: '🚀',
        icone: icone(
            nivelBoost >= 0 ? `guild_booster_lvl${nivelBoost + 1}` : null,
            ICONES_BOOST[nivelBoost >= 0 ? nivelBoost : 0]
        ),
        tem: !!boost
    });

    // Insígnias que o perfil trouxe e que não estão no nosso mapa (quests,
    // pseudônimo original, novidades que o Discord soltar depois).
    for (const [id, b] of doPerfil) {
        if (usados.has(id) || !b?.icon) continue;
        insignias.push({
            flag: id.toUpperCase(),
            nome: b.description || id,
            emoji: '🏅',
            icone: ICONE_BADGE(b.icon),
            tem: true
        });
    }

    return {
        sucesso: true,
        conta: { id: eu.id, tag: eu.tag || eu.username, avatar: eu.displayAvatarURL?.({ size: 64 }) || null },
        perfilOk: !!perfil,
        premium: { tipo: PREMIUM_NOMES[premiumType] || 'Nenhum', tipoId: premiumType },
        insignias,
        nitro,
        boost
    };
}

async function entrarCallWeb(ctx, opts) {
    const cliente = ctx.cliente;
    if (!cliente) return { sucesso: false, mensagem: 'Cliente Discord não conectado' };
    const canalId = String(opts?.canalId || '').trim();
    if (!canalId) return { sucesso: false, mensagem: 'canalId obrigatório' };

    const canal = obterCanalVoz(cliente, canalId);
    if (!canal) return { sucesso: false, mensagem: 'Canal de voz não encontrado ou conta não é membro' };
    const guild = canal.guild;
    const me = guild.members.me || guild.members.cache.get(cliente.user.id);
    if (!canal.permissionsFor(me).has('CONNECT')) {
        return { sucesso: false, mensagem: 'Sem permissão CONNECT no canal' };
    }

    // Se já estamos no mesmo canal, não duplica
    if (me?.voice?.channelId === canal.id) {
        return { sucesso: true, mensagem: 'Você já está nessa call', canal: canal.name, guild: guild.name };
    }

    // Conecta via gateway raw (opcode 4 VOICE_STATE_UPDATE) em vez de abrir uma
    // conexão de voz completa. joinChannel() exige UDP outbound, que o Railway
    // bloqueia — então o handshake dava timeout e a conta nunca conectava.
    // Mandando o op 4 direto na WebSocket, o Discord conta a conta como
    // conectada ao canal sem precisar de UDP / @discordjs/voice (sem áudio).
    const enviarVoiceState = (channelId) => {
        try {
            const shard = guild.shard;
            if (!shard) return false;
            shard.send({
                op: 4,
                d: {
                    guild_id: guild.id,
                    channel_id: channelId,
                    self_mute: false,
                    self_deaf: false,
                    self_video: false
                }
            });
            return true;
        } catch {
            return false;
        }
    };

    if (!enviarVoiceState(canal.id)) {
        return { sucesso: false, mensagem: 'Gateway WebSocket não está pronto (shard ainda conectando).' };
    }

    // Reenvia o estado se a conta cair do canal (ex.: gateway reconectou).
    let cancelado = false;
    let voiceListener, gatewayListener;

    const estouNoAlvo = () => {
        const meu = guild.members.cache.get(cliente.user?.id);
        return meu?.voice?.channelId === canal.id;
    };

    voiceListener = async (oldState, newState) => {
        if (cancelado) return;
        const idDoEvento = newState?.id || oldState?.id;
        if (idDoEvento !== cliente.user?.id) return;
        const estavaNoAlvo = oldState?.channelId === canal.id;
        const aindaNoAlvo = newState?.channelId === canal.id;
        if (estavaNoAlvo && !aindaNoAlvo) {
            await sleep(1);
            if (!cancelado && !estouNoAlvo()) enviarVoiceState(canal.id);
        }
    };
    gatewayListener = async () => {
        if (cancelado) return;
        await sleep(3);
        if (!cancelado && !estouNoAlvo()) enviarVoiceState(canal.id);
    };
    cliente.on('voiceStateUpdate', voiceListener);
    cliente.on('shardReady', gatewayListener);
    cliente.on('shardResume', gatewayListener);
    cliente.on('ready', gatewayListener);

    const stop = async () => {
        cancelado = true;
        if (voiceListener) cliente.off('voiceStateUpdate', voiceListener);
        if (gatewayListener) {
            cliente.off('shardReady', gatewayListener);
            cliente.off('shardResume', gatewayListener);
            cliente.off('ready', gatewayListener);
        }
        // Sai do canal mandando channel_id=null
        try { enviarVoiceState(null); } catch {}
    };
    // Remove qualquer task antiga de "entrar call" antes de adicionar a nova
    for (const t of ctx.tasks.getTasks()) {
        if (t.name?.startsWith('Em call:')) {
            await ctx.tasks.removeTask(t.id);
        }
    }
    ctx.tasks.addTask(`Em call: ${canal.name}`, stop, { canal: canal.name, guild: guild.name, channelId: canal.id, guildId: guild.id });

    return { sucesso: true, canal: canal.name, guild: guild.name };
}

// ============================ CLONAR CANAL (com mensagens) ============================
async function clonarCanalWeb(ctx, opts) {
    const cliente = ctx.cliente;
    const canalOrigemId = String(opts.canalOrigem || '').trim();
    const canalDestinoId = String(opts.canalDestino || '').trim();
    const webhookUrl = String(opts.webhookUrl || '').trim();
    const incluirAnexos = opts.incluirAnexos !== false;
    const delay = parseFloat(opts.delay) || (parseFloat(obterConfig().delay) || 1);

    if (!canalOrigemId) return { sucesso: false, mensagem: 'Canal de origem obrigatório.' };
    const canalOrigem = cliente.channels.cache.get(canalOrigemId);
    if (!canalOrigem) return { sucesso: false, mensagem: 'Canal de origem não encontrado.' };

    // Destino: por webhook (preserva nome/avatar do autor) OU por canal (envia pela conta)
    const usarWebhook = !!webhookUrl;
    let canalDestino = null;
    if (usarWebhook) {
        if (!isValidUrl(webhookUrl) || !webhookUrl.includes('discord.com/api/webhooks/')) {
            return { sucesso: false, mensagem: 'URL de webhook inválida.' };
        }
    } else {
        if (!canalDestinoId) return { sucesso: false, mensagem: 'Informe o ID do canal de destino ou uma URL de webhook.' };
        canalDestino = cliente.channels.cache.get(canalDestinoId);
        if (!canalDestino) return { sucesso: false, mensagem: 'Canal de destino não encontrado.' };
    }

    const { taskId, isCancelado } = criarTaskCancelavel(ctx.tasks, 'Clonar canal', {
        progress: progressoBase('coletando', 0)
    });

    (async () => {
        try {
            // 1) Coleta todas as mensagens (mais novas -> mais antigas)
            const mensagens = [];
            let ultimoId = null;
            while (true) {
                if (isCancelado()) break;
                const fetched = await canalOrigem.messages.fetch({ limit: 100, ...(ultimoId && { before: ultimoId }) });
                if (fetched.size === 0) break;
                for (const m of fetched.values()) mensagens.push(m);
                ultimoId = fetched.lastKey();
                atualizarProgresso(ctx.tasks, taskId, { atual: mensagens.length });
                await sleep(0.4);
            }
            // 2) Inverte para ordem cronológica (mais antiga -> mais nova)
            mensagens.reverse();

            atualizarProgresso(ctx.tasks, taskId, { fase: 'enviando', atual: 0, total: mensagens.length });
            let enviadas = 0, erros = 0, puladas = 0;

            for (let i = 0; i < mensagens.length; i++) {
                if (isCancelado()) break;
                const m = mensagens[i];
                const conteudo = m.content || '';
                const anexos = incluirAnexos ? [...m.attachments.values()].map((a) => a.url) : [];

                if (!conteudo && anexos.length === 0) { puladas++; atualizarProgresso(ctx.tasks, taskId, { atual: i + 1, enviadas, erros, puladas }); continue; }

                try {
                    if (usarWebhook) {
                        const username = (m.author?.username || 'desconhecido').slice(0, 80);
                        const avatar = m.author?.displayAvatarURL ? m.author.displayAvatarURL() : undefined;
                        const fd = new FormData();
                        for (let j = 0; j < anexos.length; j++) {
                            const r = await fetch(anexos[j]);
                            const ab = await r.arrayBuffer();
                            fd.append(`files[${j}]`, new Blob([ab]), nomeArquivoDaUrl(anexos[j], `arquivo${j}`));
                        }
                        fd.append('payload_json', JSON.stringify({
                            username,
                            avatar_url: avatar,
                            content: conteudo ? conteudo.slice(0, 2000) : undefined
                        }));
                        const resp = await fetch(webhookUrl, { method: 'POST', body: fd });
                        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    } else {
                        const prefixo = `**${m.author?.username || 'desconhecido'}:** `;
                        const texto = conteudo ? (prefixo + conteudo) : prefixo.trim();
                        await canalDestino.send({ content: texto.slice(0, 2000), files: anexos });
                    }
                    enviadas++;
                } catch { erros++; }

                atualizarProgresso(ctx.tasks, taskId, { atual: i + 1, enviadas, erros, puladas });
                await sleep(delay);
            }
            atualizarProgresso(ctx.tasks, taskId, { fase: 'concluido', enviadas, erros, puladas });
        } catch (e) {
            atualizarProgresso(ctx.tasks, taskId, { fase: 'erro', mensagem: e.message });
        } finally {
            agendarRemocao(ctx.tasks, taskId, 4000);
        }
    })();

    return { sucesso: true, taskId };
}

module.exports = {
    removerTodosAmigosWeb,
    entrarCallWeb,
    removerTodosServidoresWeb,
    fecharTodasDMsWeb,
    limparDMUnicaWeb,
    limparDMsAbertasWeb,
    backupDMWeb,
    scraperIconsWeb,
    clonarCanalWeb,
    isValidFileType,
    desconectarTodosCallWeb,
    moverMembrosCallWeb,
    mutarTodosCallWeb,
    ensurdecerTodosCallWeb,
    listarMembrosCallWeb,
    listarMinhaCallWeb,
    protegerMeuWeb,
    farmarHorasWeb,
    elevadorWeb,
    coleiraWeb,
    protegerUsuarioWeb,
    nicknameBloqueadoWeb,
    blacklistChatWeb,
    antiDMWeb,
    sairGruposDMWeb,
    autoReagirWeb,
    listarEmojisCustomWeb,
    obterHypeSquadWeb,
    mudarHypeSquadWeb,
    obterInsigniasWeb
};
