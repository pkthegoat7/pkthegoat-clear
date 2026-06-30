// Roda na página do painel (painel.disclaw.cc). Faz a ponte entre o botão do
// painel e o background da extensão. O token é buscado AQUI (mesma origem do
// painel, cookie de sessão é enviado) e nunca passa pelo JS da página do painel.

function anunciar() {
    try { window.postMessage({ __selfExt: 'ready' }, location.origin); } catch (e) {}
}
anunciar();
window.addEventListener('load', anunciar);

window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__selfExt !== 'open' || !d.nome) return;
    try {
        const r = await fetch('/api/tokens/valor', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome: d.nome })
        });
        const j = await r.json().catch(() => null);
        if (!j || !j.sucesso || !j.token) {
            window.postMessage({ __selfExt: 'erro', msg: (j && j.mensagem) || 'token não obtido' }, location.origin);
            return;
        }
        chrome.runtime.sendMessage({ action: 'openSelf', token: j.token, nome: d.nome }, (resp) => {
            const ok = resp && resp.ok;
            window.postMessage({ __selfExt: ok ? 'aberto' : 'erro', msg: resp && resp.msg, nome: d.nome }, location.origin);
        });
    } catch (err) {
        window.postMessage({ __selfExt: 'erro', msg: String((err && err.message) || err) }, location.origin);
    }
});
