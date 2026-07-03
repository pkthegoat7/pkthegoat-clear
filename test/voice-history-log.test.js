// Regressão de performance: o handler de voz NÃO pode inundar o stdout.
// Em servidores grandes o selfbot vê 500+ voiceStateUpdate/s; cada console.log
// síncrono para o pipe do Railway trava o event loop e deixa o painel lento.
process.env.ENCRYPTION_KEY = 'chave-de-teste-com-mais-de-32-bytes-aaaaaaaa';
delete process.env.PKT_VOICE_LOG; // garante o default (logging desligado)

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const vh = require('../src/services/voice-history');

function estado({ id, channelId, channelName }) {
    return {
        id,
        channelId: channelId || null,
        guild: { id: 'g1', name: 'Servidor' },
        channel: channelId ? { id: channelId, name: channelName || 'canal', members: new Map() } : null,
        member: { displayName: 'Fulano', user: { username: 'fulano' } }
    };
}

function contarLogsVoice(fn) {
    const orig = console.log;
    let n = 0;
    console.log = (...a) => { if (String(a[0] ?? '').startsWith('[voice]')) n++; };
    try { fn(); } finally { console.log = orig; }
    return n;
}

test('join NÃO loga com PKT_VOICE_LOG desligado, mas registra a sessão', () => {
    const client = new EventEmitter();
    vh.attachClient(client);
    const uid = 'u-join-' + Date.now();
    const logs = contarLogsVoice(() => {
        client.emit('voiceStateUpdate',
            estado({ id: uid, channelId: null }),
            estado({ id: uid, channelId: 'c1', channelName: 'geral' }));
    });
    assert.strictEqual(logs, 0, 'não deve logar por padrão');
    const hist = vh.getVoiceHistory(uid);
    assert.ok(hist && hist.ativa, 'a sessão de voz deve ter sido registrada mesmo sem log');
});

test('evento sem troca de canal (mute/surdo) é no-op: não loga nem abre sessão', () => {
    const client = new EventEmitter();
    vh.attachClient(client);
    const uid = 'u-mute-' + Date.now();
    const logs = contarLogsVoice(() => {
        client.emit('voiceStateUpdate',
            estado({ id: uid, channelId: 'c1' }),
            estado({ id: uid, channelId: 'c1' })); // mesmo canal
    });
    assert.strictEqual(logs, 0, 'toggle no mesmo canal não deve logar');
    assert.strictEqual(vh.getVoiceHistory(uid), null, 'toggle no mesmo canal não deve criar histórico');
});

test('com PKT_VOICE_LOG=1 o log volta (recuperável para debug)', () => {
    // Recarrega o módulo com a flag ligada, isolado do require cache.
    const path = require.resolve('../src/services/voice-history');
    delete require.cache[path];
    process.env.PKT_VOICE_LOG = '1';
    const vh2 = require('../src/services/voice-history');
    const client = new EventEmitter();
    vh2.attachClient(client);
    const uid = 'u-log-' + Date.now();
    const logs = contarLogsVoice(() => {
        client.emit('voiceStateUpdate',
            estado({ id: uid, channelId: null }),
            estado({ id: uid, channelId: 'c1', channelName: 'geral' }));
    });
    delete process.env.PKT_VOICE_LOG;
    delete require.cache[path];
    assert.strictEqual(logs, 1, 'com a flag ligada deve logar exatamente 1 vez');
});
