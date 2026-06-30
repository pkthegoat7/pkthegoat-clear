// Roda na página do painel (painel.disclaw.cc). Ponte entre os botões do painel
// e o background. O token é buscado AQUI (mesma origem do painel, o cookie de
// sessão é enviado) e nunca passa pelo JS da página do painel.

const VERSAO = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?';
console.log('[selfExt] content.js v' + VERSAO + ' carregado em', location.href);

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

window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d.nome) return;
    if (d.__selfExt !== 'open' && d.__selfExt !== 'embed') return;

    console.log('[selfExt] pedido:', d.__selfExt, 'conta:', d.nome);
    try {
        const token = await obterToken(d.nome);
        console.log('[selfExt] token obtido (', token.length, 'chars)');

        if (d.__selfExt === 'open') {
            chrome.runtime.sendMessage({ action: 'openSelf', token, nome: d.nome }, (resp) => {
                const erro = chrome.runtime.lastError;
                const ok = !erro && resp && resp.ok;
                console.log('[selfExt] openSelf resp:', resp, erro);
                window.postMessage({ __selfExt: ok ? 'aberto' : 'erro', msg: (erro && erro.message) || (resp && resp.msg), nome: d.nome }, location.origin);
            });
        } else {
            chrome.runtime.sendMessage({ action: 'setPending', token }, (resp) => {
                const erro = chrome.runtime.lastError;
                console.log('[selfExt] setPending resp:', resp, erro);
                if (erro) { window.postMessage({ __selfExt: 'erro', msg: erro.message }, location.origin); return; }
                window.postMessage({ __selfExt: 'embedReady', nome: d.nome }, location.origin);
            });
        }
    } catch (err) {
        console.error('[selfExt] erro:', err);
        window.postMessage({ __selfExt: 'erro', msg: String((err && err.message) || err) }, location.origin);
    }
});
