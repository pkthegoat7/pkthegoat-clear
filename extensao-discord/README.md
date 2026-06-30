# Extensão — Discord web do self

Abre o **Discord web logado como uma conta salva no painel**, direto no teu
navegador. Tudo nativo: **áudio, microfone e vídeo funcionam** sem servidor,
sem streaming. É a alternativa leve à aba "Tela do self".

## Como funciona
Quando instalada, a aba **"Tela do self"** ganha botões:
- **"Abrir Discord web aqui"** — embute o Discord como uma **miniatura** dentro
  do próprio painel (iframe). A extensão remove o bloqueio de iframe do
  discord.com e injeta o token no iframe.
- **"↗ Nova aba"** — abre o Discord logado numa aba separada.
- **"Fechar miniatura"** — fecha o iframe.

Escolhe a conta (token salvo) no seletor e clica. O token **não passa** pelo
JavaScript da página do painel — só pela extensão (que o busca via teu login).

Tudo roda no teu navegador: **áudio, microfone e vídeo nativos**.

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
