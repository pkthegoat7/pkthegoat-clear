// Roda na página do painel (painel.disclaw.cc). Ponte entre os botões do painel
// e o background. O token é buscado AQUI (mesma origem do painel, o cookie de
// sessão é enviado) e nunca passa pelo JS da página do painel.

const VERSAO = (chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?';
console.log('[selfExt] content.js v' + VERSAO + ' carregado em', location.href);

// O contexto da extensão fica inválido quando ela é recarregada/atualizada com a
// página já aberta. Aí chrome.runtime some e dá "sendMessage of undefined".
function extValido() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
}
function avisarRecarregar() {
    window.postMessage({ __selfExt: 'erro', msg: 'Extensão recarregada — atualize esta página (Ctrl+Shift+R).' }, location.origin);
}

function anunciar() {
    try { window.postMessage({ __selfExt: 'ready', versao: VERSAO }, location.origin); } catch (e) {}
}
anunciar();
window.addEventListener('load', anunciar);

async function obterToken(nome) {
    const r = await fetch('/api/tokens/valor', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome })
    });
    const j = await r.json().catch(() => null);
    if (!j || !j.sucesso || !j.token) throw new Error((j && j.mensagem) || ('token não obtido (HTTP ' + r.status + ')'));
    return j.token;
}

function enviarBg(payload) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage(payload, (resp) => {
                const erro = chrome.runtime.lastError;
                resolve({ resp, erro: erro && erro.message });
            });
        } catch (e) {
            resolve({ resp: null, erro: String((e && e.message) || e) });
        }
    });
}

window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d.nome) return;
    if (d.__selfExt !== 'open' && d.__selfExt !== 'embed') return;

    if (!extValido()) { console.warn('[selfExt] contexto inválido'); avisarRecarregar(); return; }
    console.log('[selfExt] pedido:', d.__selfExt, 'conta:', d.nome);
    try {
        const token = await obterToken(d.nome);
        console.log('[selfExt] token obtido (', token.length, 'chars)');
        if (!extValido()) { avisarRecarregar(); return; }

        if (d.__selfExt === 'open') {
            const { resp, erro } = await enviarBg({ action: 'openSelf', token, nome: d.nome });
            const ok = !erro && resp && resp.ok;
            window.postMessage({ __selfExt: ok ? 'aberto' : 'erro', msg: erro || (resp && resp.msg), nome: d.nome }, location.origin);
        } else {
            const { erro } = await enviarBg({ action: 'setPending', token });
            if (erro) { window.postMessage({ __selfExt: 'erro', msg: erro }, location.origin); return; }
            window.postMessage({ __selfExt: 'embedReady', nome: d.nome }, location.origin);
        }
    } catch (err) {
        console.error('[selfExt] erro:', err);
        window.postMessage({ __selfExt: 'erro', msg: String((err && err.message) || err) }, location.origin);
    }
});
