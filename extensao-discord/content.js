// Roda na página do painel (painel.disclaw.cc). Ponte entre os botões do painel
// e o background. O token é buscado AQUI (mesma origem do painel, o cookie de
// sessão é enviado) e nunca passa pelo JS da página do painel.

function anunciar() {
    try { window.postMessage({ __selfExt: 'ready' }, location.origin); } catch (e) {}
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
    if (!j || !j.sucesso || !j.token) throw new Error((j && j.mensagem) || 'token não obtido');
    return j.token;
}

window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d.nome) return;

    // Abrir em NOVA ABA
    if (d.__selfExt === 'open') {
        try {
            const token = await obterToken(d.nome);
            chrome.runtime.sendMessage({ action: 'openSelf', token, nome: d.nome }, (resp) => {
                const ok = resp && resp.ok;
                window.postMessage({ __selfExt: ok ? 'aberto' : 'erro', msg: resp && resp.msg, nome: d.nome }, location.origin);
            });
        } catch (err) {
            window.postMessage({ __selfExt: 'erro', msg: String((err && err.message) || err) }, location.origin);
        }
    }

    // Embutir como MINIATURA (iframe) no painel
    if (d.__selfExt === 'embed') {
        try {
            const token = await obterToken(d.nome);
            chrome.runtime.sendMessage({ action: 'setPending', token }, () => {
                // Avisa o painel para carregar/recarregar o iframe do discord.
                window.postMessage({ __selfExt: 'embedReady', nome: d.nome }, location.origin);
            });
        } catch (err) {
            window.postMessage({ __selfExt: 'erro', msg: String((err && err.message) || err) }, location.origin);
        }
    }
});
