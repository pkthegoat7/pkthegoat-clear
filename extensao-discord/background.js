// Recebe o token do content script e abre o Discord web logado como o self:
// injeta o token no localStorage do discord.com (algo que o painel, por ser
// outra origem, não consegue) e recarrega para a tela principal.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.action === 'openSelf' && msg.token) {
        abrirSelf(msg.token)
            .then(() => sendResponse({ ok: true }))
            .catch((e) => sendResponse({ ok: false, msg: String((e && e.message) || e) }));
        return true; // resposta assíncrona
    }
});

async function abrirSelf(token) {
    const tab = await chrome.tabs.create({ url: 'https://discord.com/login', active: true });
    await esperarComplete(tab.id);
    // Mundo ISOLATED (padrão): tem o próprio window, mas o localStorage é o da
    // origem discord.com — então funciona mesmo o Discord apagando o localStorage
    // do mundo principal. Set + reload = login.
    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [token],
        func: (t) => {
            try { localStorage.setItem('token', '"' + t + '"'); } catch (e) {}
            location.href = 'https://discord.com/channels/@me';
        }
    });
}

function esperarComplete(tabId) {
    return new Promise((resolve) => {
        let done = false;
        const fin = () => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(check); resolve(); };
        function check(id, info) { if (id === tabId && info.status === 'complete') fin(); }
        chrome.tabs.onUpdated.addListener(check);
        setTimeout(fin, 15000); // fallback
    });
}
