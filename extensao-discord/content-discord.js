// Roda dentro do discord.com (inclusive no iframe embutido no painel). Quando há
// um token pendente (escolhido no painel) e estamos embutidos, injeta o token no
// localStorage e recarrega para a tela principal — logando como o self.

(function () {
    // Só age quando embutido num iframe (a aba normal do Discord não mexe).
    if (window.top === window.self) return;
    try {
        chrome.runtime.sendMessage({ action: 'getPending' }, (resp) => {
            if (chrome.runtime.lastError) return;
            if (!resp || !resp.token) return;
            try {
                const alvo = '"' + resp.token + '"';
                if (localStorage.getItem('token') !== alvo) {
                    localStorage.setItem('token', alvo);
                    location.replace('https://discord.com/channels/@me');
                }
            } catch (e) {}
        });
    } catch (e) {}
})();
