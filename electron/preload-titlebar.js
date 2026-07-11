'use strict';

// Ponte segura entre a barra de título customizada (titlebar.html) e o main.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appbar', {
	// Ações de janela: 'close' | 'min' | 'max'
	win: (acao) => ipcRenderer.send('win-action', acao),
	// Abre o menu nativo de contas (desenha por cima do BrowserView).
	accountsMenu: () => ipcRenderer.send('accounts-menu'),
	// Recebe o nome da conta ativa (ou null quando é o painel).
	onAccount: (cb) => ipcRenderer.on('account', (_e, nome) => cb(nome)),
	// Recebe o tema de aparência ('glass-dark'|'mica'|'solido').
	onGlass: (cb) => ipcRenderer.on('glass', (_e, tema) => cb(tema))
});
