/**
 * Registro local de atividade de voz dos usuários que o selfbot vê em servidores
 * comuns. Discord não expõe histórico de calls em servidor via API — então
 * só conseguimos saber o que vimos ao vivo enquanto o bot estava conectado.
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
    return cache;
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

function recordJoin({ userId, guildId, guildName, channelId, channelName }) {
    if (!userId || !channelId) return;
    const e = entradaDe(userId);
    // Se já há uma sessão aberta sem fim, fecha agora (mudança de canal sem leave).
    if (e.aberta && !e.aberta.leftAt) {
        e.aberta.leftAt = Date.now();
        e.sessoes.push(e.aberta);
        if (e.sessoes.length > 100) e.sessoes.splice(0, e.sessoes.length - 100);
    }
    e.aberta = {
        guildId: guildId || null,
        guildName: guildName || null,
        channelId,
        channelName: channelName || null,
        joinedAt: Date.now(),
        leftAt: null
    };
    agendarSalvar();
}

function recordLeave(userId) {
    if (!userId) return;
    const e = entradaDe(userId);
    if (!e.aberta) return;
    e.aberta.leftAt = Date.now();
    e.sessoes.push(e.aberta);
    e.aberta = null;
    if (e.sessoes.length > 100) e.sessoes.splice(0, e.sessoes.length - 100);
    agendarSalvar();
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

function attachClient(client) {
    if (!client || client.__pkVoiceHistoryAttached) return;
    client.__pkVoiceHistoryAttached = true;
    client.on('voiceStateUpdate', (oldState, newState) => {
        try {
            const userId = newState?.id || oldState?.id;
            if (!userId) return;
            const antesCh = oldState?.channelId || null;
            const depoisCh = newState?.channelId || null;
            if (!antesCh && depoisCh) {
                // entrou
                const g = newState.guild;
                const ch = newState.channel;
                recordJoin({
                    userId,
                    guildId: g?.id || null,
                    guildName: g?.name || null,
                    channelId: depoisCh,
                    channelName: ch?.name || null
                });
            } else if (antesCh && !depoisCh) {
                // saiu
                recordLeave(userId);
            } else if (antesCh && depoisCh && antesCh !== depoisCh) {
                // trocou de canal
                const g = newState.guild;
                const ch = newState.channel;
                recordJoin({
                    userId,
                    guildId: g?.id || null,
                    guildName: g?.name || null,
                    channelId: depoisCh,
                    channelName: ch?.name || null
                });
            }
        } catch {}
    });
}

process.on('exit', () => { try { persist(); } catch {} });

module.exports = { recordJoin, recordLeave, getVoiceHistory, attachClient };
