# GoatCord

Selfbot do Discord em app de desktop (Electron) com painel próprio: limpeza de DMs, utilidades de call, backup, Rich Presence, VPN com túnel dividido e mais.

## Rodar em desenvolvimento

```bash
npm install
npm start
```

## Gerar o instalador

```bash
npm run app:build
```

O instalador sai em `dist-electron/GoatCord-setup.exe`.

## Atualização automática

O app instalado baixa a branch `main` deste repositório toda vez que abre (`electron/bootstrap.js`). Push na `main` vira atualização em todos os PCs. Mudança nas `dependencies` do `package.json` exige gerar e instalar um instalador novo.

## Aviso

Self-bots violam os [Termos de Serviço do Discord](https://discord.com/terms). Use por sua conta e risco.
