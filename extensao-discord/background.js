// Ponte entre o painel e o discord.com.
//  - "openSelf": abre o Discord numa NOVA aba logado como o self.
//  - "setPending"/"getPending": guarda o token escolhido para o iframe embutido
//    no painel (a miniatura) injetar via content-discord.js.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;

    if (msg.action === 'openSelf' && msg.token) {
        abrirSelfNovaAba(msg.token)
            .then(() => sendResponse({ ok: true }))
            .catch((e) => sendResponse({ ok: false, msg: String((e && e.message) || e) }));
        return true;
    }

    if (msg.action === 'setPending') {
        chrome.storage.session.set({ pendingToken: msg.token || null })
            .then(() => sendResponse({ ok: true }))
            .catch(() => sendResponse({ ok: false }));
        return true;
    }

    if (msg.action === 'getPending') {
        chrome.storage.session.get('pendingToken')
            .then((o) => sendResponse({ token: o.pendingToken || null }))
            .catch(() => sendResponse({ token: null }));
        return true;
    }
});

async function abrirSelfNovaAba(token) {
    const tab = await chrome.tabs.create({ url: 'https://discord.com/login', active: true });
    await esperarComplete(tab.id);
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
        setTimeout(fin, 15000);
    });
}
