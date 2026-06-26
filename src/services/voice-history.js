/**
 * Registro local de atividade de voz dos usuários que o selfbot vê em servidores
 * comuns. Discord não expõe histórico de calls em servidor via API — só
 * conseguimos saber o que vimos ao vivo enquanto o bot estava conectado.
 *
 * Cada sessão guarda também os outros membros que estiveram no canal durante
 * o intervalo, em membersSeen — útil pra reconstruir "quem estava na call".
 *
 * Persistido em data/voice-history.json.
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('./auth');

const FILE = path.join(dataDir(), 'voice-history.json');

let cache = null;
let dirty = false;
let saveTimer = null;

// Index em memória: channelId -> Set<userId com sessão aberta neste canal>.
// Reconstruído a partir do cache no primeiro load(), e mantido pelos hooks.
const canalAbertas = new Map();

function load() {
    if (cache) return cache;
    try {
        if (fs.existsSync(FILE)) {
            cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        } else {
            cache = {};
        }
    } catch {
        cache = {};
    }
    // Reconstrói canalAbertas a partir das sessões abertas persistidas.
    for (const [uid, e] of Object.entries(cache)) {
        if (e && e.aberta && e.aberta.channelId) {
            indexar(e.aberta.channelId, uid);
        }
    }
    return cache;
}

function indexar(channelId, userId) {
    if (!canalAbertas.has(channelId)) canalAbertas.set(channelId, new Set());
    canalAbertas.get(channelId).add(userId);
}

function desindexar(channelId, userId) {
    const s = canalAbertas.get(channelId);
    if (!s) return;
    s.delete(userId);
    if (s.size === 0) canalAbertas.delete(channelId);
}

function persist() {
    if (!dirty) return;
    try {
        const d = dataDir();
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
        dirty = false;
    } catch {}
}

function agendarSalvar() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 3000);
    if (saveTimer.unref) saveTimer.unref();
}

function entradaDe(userId) {
    const c = load();
    if (!c[userId]) c[userId] = { sessoes: [], aberta: null };
    if (!Array.isArray(c[userId].sessoes)) c[userId].sessoes = [];
    return c[userId];
}

function adicionarMembro(sessao, membro) {
    if (!sessao || !membro || !membro.id) return false;
    sessao.membersSeen ||= [];
    const existente = sessao.membersSeen.find((m) => m.id === membro.id);
    if (existente) {
        existente.lastSeenAt = Date.now();
        if (membro.name && !existente.name) existente.name = membro.name;
        return false;
    }
    sessao.membersSeen.push({
        id: membro.id,
        name: membro.name || null,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now()
    });
    if (sessao.membersSeen.length > 200) sessao.membersSeen.splice(0, sessao.membersSeen.length - 200);
    return true;
}

function recordJoin({ userId, guildId, guildName, channelId, channelName, presentMembers }) {
    if (!userId || !channelId) return;
    const e = entradaDe(userId);
    if (e.aberta && !e.aberta.leftAt) {
        e.aberta.leftAt = Date.now();
        if (e.aberta.channelId) desindexar(e.aberta.channelId, userId);
        e.sessoes.push(e.aberta);
        if (e.sessoes.length > 100) e.sessoes.splice(0, e.sessoes.length - 100);
    }
    e.aberta = {
        guildId: guildId || null,
        guildName: guildName || null,
        channelId,
        channelName: channelName || null,
        joinedAt: Date.now(),
        leftAt: null,
        membersSeen: []
    };
    indexar(channelId, userId);

    // Snapshot inicial: quem já estava no canal quando o alvo entrou.
    if (Array.isArray(presentMembers)) {
        for (const m of presentMembers) {
            if (m && m.id && m.id !== userId) adicionarMembro(e.aberta, m);
        }
    }
    agendarSalvar();
}

function recordLeave(userId) {
    if (!userId) return;
    const e = entradaDe(userId);
    if (!e.aberta) return;
    e.aberta.leftAt = Date.now();
    if (e.aberta.channelId) desindexar(e.aberta.channelId, userId);
    e.sessoes.push(e.aberta);
    e.aberta = null;
    if (e.sessoes.length > 100) e.sessoes.splice(0, e.sessoes.length - 100);
    agendarSalvar();
}

// Quando QUALQUER usuário entra no canal X, anota nos sessões abertas dos outros
// que estão no mesmo canal X — assim cada alvo acumula "quem passou pela call".
function notificarEntradaNoCanal(channelId, membro) {
    if (!channelId || !membro || !membro.id) return;
    const abertas = canalAbertas.get(channelId);
    if (!abertas || abertas.size === 0) return;
    let mudou = false;
    for (const outroUid of abertas) {
        if (outroUid === membro.id) continue;
        const e = entradaDe(outroUid);
        if (e.aberta && e.aberta.channelId === channelId) {
            if (adicionarMembro(e.aberta, membro)) mudou = true;
        }
    }
    if (mudou) agendarSalvar();
}

function getVoiceHistory(userId) {
    const c = load();
    const e = c[userId];
    if (!e) return null;
    const sessoes = (e.sessoes || []).slice().reverse();
    return {
        ativa: e.aberta ? { ...e.aberta } : null,
        sessoes: sessoes.slice(0, 20)
    };
}

function snapshotMembros(channel, excluirId) {
    if (!channel || !channel.members) return [];
    const out = [];
    try {
        for (const m of channel.members.values()) {
            if (excluirId && m.id === excluirId) continue;
            out.push({
                id: m.id,
                name: m.displayName || m.nickname || m.user?.globalName || m.user?.username || null
            });
        }
    } catch {}
    return out;
}

function attachClient(client) {
    if (!client || client.__pkVoiceHistoryAttached) return;
    client.__pkVoiceHistoryAttached = true;
    load(); // garante que canalAbertas é reconstruído
    client.on('voiceStateUpdate', (oldState, newState) => {
        try {
            const userId = newState?.id || oldState?.id;
            if (!userId) return;
            const antesCh = oldState?.channelId || null;
            const depoisCh = newState?.channelId || null;

            const meta = {
                userId,
                guildId: newState?.guild?.id || oldState?.guild?.id || null,
                guildName: newState?.guild?.name || oldState?.guild?.name || null,
                channelId: depoisCh,
                channelName: newState?.channel?.name || null,
                presentMembers: snapshotMembros(newState?.channel, userId)
            };

            const membroAtual = {
                id: userId,
                name: newState?.member?.displayName
                    || newState?.member?.nickname
                    || newState?.member?.user?.globalName
                    || newState?.member?.user?.username
                    || oldState?.member?.user?.username
                    || null
            };

            if (!antesCh && depoisCh) {
                recordJoin(meta);
                notificarEntradaNoCanal(depoisCh, membroAtual);
            } else if (antesCh && !depoisCh) {
                recordLeave(userId);
            } else if (antesCh && depoisCh && antesCh !== depoisCh) {
                recordJoin(meta);
                notificarEntradaNoCanal(depoisCh, membroAtual);
            }
            // mute/deaf/etc no mesmo canal: nada a fazer.
        } catch {}
    });
}

process.on('exit', () => { try { persist(); } catch {} });

module.exports = { recordJoin, recordLeave, getVoiceHistory, attachClient };
