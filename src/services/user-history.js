/**
 * Histórico local de nomes/avatares/banners dos usuários que o selfbot vê.
 * Persistido em data/user-history.json.
 *
 * Cada entrada é alimentada por:
 *   - eventos userUpdate (mudou nome/avatar)
 *   - messageCreate (autor da mensagem)
 *   - presenceUpdate
 *   - chamadas explícitas a recordUser(u) (ex.: ao consultar pelo User Lookup)
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('./auth');

const FILE = path.join(dataDir(), 'user-history.json');

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
    saveTimer = setTimeout(() => {
        saveTimer = null;
        persist();
    }, 3000);
    if (saveTimer.unref) saveTimer.unref();
}

function entradaDe(userId) {
    const c = load();
    if (!c[userId]) {
        c[userId] = {
            firstSeen: Date.now(),
            usernames: [],
            globalNames: [],
            avatars: [],
            banners: []
        };
    }
    const e = c[userId];
    e.usernames ||= [];
    e.globalNames ||= [];
    e.avatars ||= [];
    e.banners ||= [];
    return e;
}

function adicionarSeNovo(arr, value) {
    if (value == null || value === '') return false;
    const last = arr[arr.length - 1];
    if (last && last.value === value) return false;
    arr.push({ value, seenAt: Date.now() });
    if (arr.length > 50) arr.splice(0, arr.length - 50);
    return true;
}

function avatarUrlDe(userId, hash) {
    if (!hash) return null;
    const ext = hash.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${userId}/${hash}.${ext}?size=512`;
}

function bannerUrlDe(userId, hash) {
    if (!hash) return null;
    const ext = hash.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/banners/${userId}/${hash}.${ext}?size=1024`;
}

function recordUser(user) {
    if (!user || !user.id) return;
    const e = entradaDe(user.id);
    e.lastSeen = Date.now();
    let mudou = false;
    if (adicionarSeNovo(e.usernames, user.username || null)) mudou = true;
    if (adicionarSeNovo(e.globalNames, user.globalName || null)) mudou = true;
    if (adicionarSeNovo(e.avatars, avatarUrlDe(user.id, user.avatar))) mudou = true;
    if (user.banner !== undefined && adicionarSeNovo(e.banners, bannerUrlDe(user.id, user.banner))) mudou = true;
    if (mudou) agendarSalvar();
}

function getHistory(userId) {
    const c = load();
    const e = c[userId];
    if (!e) return null;
    return {
        firstSeen: e.firstSeen || null,
        lastSeen: e.lastSeen || null,
        usernames: (e.usernames || []).slice(),
        globalNames: (e.globalNames || []).slice(),
        avatars: (e.avatars || []).slice(),
        banners: (e.banners || []).slice()
    };
}

function attachClient(client) {
    if (!client || client.__pkHistoryAttached) return;
    client.__pkHistoryAttached = true;
    client.on('userUpdate', (_oldU, newU) => {
        try { recordUser(newU); } catch {}
    });
    client.on('messageCreate', (msg) => {
        try { if (msg?.author) recordUser(msg.author); } catch {}
    });
    client.on('presenceUpdate', (_oldP, newP) => {
        try {
            const u = newP?.user || newP?.member?.user;
            if (u) recordUser(u);
        } catch {}
    });
}

process.on('exit', () => { try { persist(); } catch {} });

module.exports = { recordUser, getHistory, attachClient };
