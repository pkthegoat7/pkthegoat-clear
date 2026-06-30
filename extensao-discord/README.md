# Extensão — Discord web do self

Abre o **Discord web logado como uma conta salva no painel**, direto no teu
navegador. Tudo nativo: **áudio, microfone e vídeo funcionam** sem servidor,
sem streaming. É a alternativa leve à aba "Tela do self".

## Como funciona
1. Na aba **"Tela do self"** do painel aparece o botão **"Abrir no Discord web
   (extensão)"** quando a extensão está instalada.
2. Escolhe a conta (token salvo) e clica.
3. A extensão pega o token do painel (mesma origem, via teu login) e abre o
   `discord.com` logado como aquela conta.

O token **não passa** pelo JavaScript da página do painel — só pela extensão.

## Instalar (Chrome / Edge / Brave)
1. Baixe/copie esta pasta `extensao-discord/` para o teu PC.
2. Abra `chrome://extensions`.
3. Ative o **"Modo do desenvolvedor"** (canto superior direito).
4. Clique em **"Carregar sem compactação"** e selecione a pasta `extensao-discord`.
5. Pronto. Abra o painel (`painel.disclaw.cc`), vá em **Tela do self** e o botão
   aparece.

## ⚠️ Avisos
- A conta (self) fica logada **no teu navegador** — é o Discord web de verdade.
- Usar self-bot / automatizar conta viola os Termos do Discord. Risco de ban é
  por tua conta.
- A extensão só funciona no painel `painel.disclaw.cc` e no `discord.com`.

## Arquivos
- `manifest.json` — permissões e registro.
- `content.js` — roda no painel; busca o token e repassa ao background.
- `background.js` — abre o discord.com e injeta o token no localStorage.
