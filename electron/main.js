'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, BrowserView, Menu, ipcMain, shell, dialog, session } = require('electron');

// Tela preta do Discord no Electron geralmente vem da GPU estar na blocklist do
// Chromium, caindo num render quebrado. Forçar a GPU (ignore-gpu-blocklist) tende
// a resolver o preto SEM desligar a aceleração — o que manteria o app pesado
// (tudo na CPU). Mantemos a GPU LIGADA pra performance.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
// Garante que câmera e microfone funcionem no BrowserView (Discord web).
// use-fake-ui-for-media-stream=false força o Chromium a usar os dispositivos
// reais em vez de uma UI falsa que bloqueia getUserMedia silenciosamente.
app.commandLine.appendSwitch('use-fake-ui-for-media-stream', 'false');
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

// ===== Rebrand GoatCord =====
// O app agora se chama "GoatCord". Como o nome define a pasta de dados
// (%APPDATA%\<nome>), migramos UMA vez a pasta antiga ("pkthegoat-clear") para a
// nova, pra ninguém perder login/tokens/config ao atualizar.
app.setName('GoatCord');
if (!process.env.PORTABLE_EXECUTABLE_DIR) {
	try {
		const baseAppData = app.getPath('appData'); // %APPDATA%
		const pastaNova = path.join(baseAppData, 'GoatCord');
		const pastaAntiga = path.join(baseAppData, 'pkthegoat-clear');
		if (!fs.existsSync(pastaNova) && fs.existsSync(pastaAntiga)) {
			try {
				fs.renameSync(pastaAntiga, pastaNova);
			} catch {
				// rename entre locais pode falhar (lock/volume): copia recursivo.
				fs.cpSync(pastaAntiga, pastaNova, { recursive: true });
			}
		}
	} catch {
		/* migração best-effort: se falhar, o app abre com dados vazios, sem quebrar */
	}
}

// ===== Modo portátil =====
// O target "portable" do electron-builder define PORTABLE_EXECUTABLE_DIR (pasta
// onde está o .exe). Nesse modo, TODOS os dados (contas, config, sessão do
// Discord, backups) ficam em "pkthegoat-clear-data" ao lado do .exe, sem tocar
// no %APPDATA% — dá pra levar num pendrive.
if (process.env.PORTABLE_EXECUTABLE_DIR) {
	const dirPortatil = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'GoatCord-data');
	try {
		// Migra a pasta portátil antiga ("pkthegoat-clear-data"), se existir.
		const dirPortatilAntigo = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'pkthegoat-clear-data');
		if (!fs.existsSync(dirPortatil) && fs.existsSync(dirPortatilAntigo)) {
			try {
				fs.renameSync(dirPortatilAntigo, dirPortatil);
			} catch {
				fs.cpSync(dirPortatilAntigo, dirPortatil, { recursive: true });
			}
		}
		fs.mkdirSync(dirPortatil, { recursive: true });
		app.setPath('userData', dirPortatil);
		app.setPath('sessionData', dirPortatil);
		process.chdir(dirPortatil); // backups/progresso usam process.cwd()
	} catch {
		/* pasta sem permissão de escrita: cai no %APPDATA% padrão */
	}
}

// ===== Base do modo local (storage em arquivo, sem Supabase) =====
process.env.PKTHEGOAT_LOCAL = '1';
delete process.env.PORT; // nunca liga o "modo produção" (reexigiria HTTPS etc.)
process.env.PKTHEGOAT_HOME = app.getPath('userData'); // base gravável (fora do asar)
if (!process.env.ENCRYPTION_KEY) {
	process.env.ENCRYPTION_KEY = 'pkthegoat-local-default-encryption-key-32b+';
}

// ===== Tracker API (aba "Buscar usuário": histórico de nomes/avatares, presença,
// voz, atividades). A chave de LEITURA vem de electron/tracker.local.json
// (gitignored). Sem o arquivo, o lookup funciona só com os dados nativos do Discord.
if (!process.env.TRACKER_API_URL) {
	process.env.TRACKER_API_URL = 'https://tracker-production-db0f.up.railway.app';
}
try {
	const tk = require('./tracker.local.json');
	if (tk && tk.url) process.env.TRACKER_API_URL = String(tk.url).replace(/\/+$/, '');
	if (tk && tk.key) process.env.TRACKER_API_KEY = String(tk.key).trim();
} catch {
	/* sem arquivo: tracker desligado, lookup usa só o Discord nativo */
}

// ===== Login via Discord (OAuth2), opcional =====
// Se electron/oauth.local.json tiver client id + secret válidos, o app passa a
// EXIGIR login com Discord (build pra distribuir). Sem isso, cai no modo pessoal
// sem login (super-admin automático).
const PORTA_FIXA_OAUTH = 4147;
function carregarOAuth() {
	try {
		const cfg = require('./oauth.local.json');
		const id = cfg && String(cfg.clientId || '').trim();
		const secret = cfg && String(cfg.secret || '').trim();
		if (/^\d{15,25}$/.test(id) && secret && secret.length > 10) {
			process.env.DISCORD_CLIENT_ID = id;
			process.env.DISCORD_CLIENT_SECRET = secret;
			process.env.DISCORD_REDIRECT_URI = `http://127.0.0.1:${PORTA_FIXA_OAUTH}/api/auth/discord/callback`;
			process.env.PKTHEGOAT_PORT = String(PORTA_FIXA_OAUTH); // porta estável pro redirect
			process.env.PKTHEGOAT_AUTH = '1'; // exige login no servidor
			if (cfg.superAdminDiscordId) process.env.SUPERADMIN_DISCORD_ID = String(cfg.superAdminDiscordId).trim();
			return true;
		}
	} catch {}
	return false;
}
const OAUTH_ON = carregarOAuth();

// DevTools DESLIGADO por padrão (usuários não devem ter acesso). O dono pode
// religar setando PKTHEGOAT_DEVTOOLS=1 no ambiente pra depurar.
const DEVTOOLS = process.env.PKTHEGOAT_DEVTOOLS === '1';

// ===== Aparência: modo glass (acrylic do Windows 11, tipo vibrancy do macOS) =====
// Acrylic (DWM) só existe no Win11 (build 22000+); no Win10 a janela transparente
// ficaria preta, então o modo nem é oferecido.
const SUPORTA_GLASS = process.platform === 'win32' && parseInt(os.release().split('.')[2] || '0', 10) >= 22000;

const ARQ_PREFS = path.join(app.getPath('userData'), 'ui-prefs.json');
function lerPrefs() {
	try {
		return JSON.parse(fs.readFileSync(ARQ_PREFS, 'utf8')) || {};
	} catch {
		return {};
	}
}
function salvarPrefs(mudanca) {
	try {
		fs.writeFileSync(ARQ_PREFS, JSON.stringify({ ...lerPrefs(), ...mudanca }));
	} catch {}
}
// Temas de aparência estilo macOS. O material é o efeito do DWM na janela
// (acrylic = blur forte do desktop, mica = tinta sutil do papel de parede).
// NOTA: o material 'mica' do DWM não tem efeito em janela frameless (bug conhecido
// do Electron no Win11) — só o acrylic funciona. O tema Mica é EMULADO: acrylic com
// tinte quase opaco, que dá o mesmo visual de tinta sutil do papel de parede.
const TEMAS = {
	'glass-dark': { rotulo: 'Glass (blur)', material: 'acrylic', discord: '45%' },
	mica: { rotulo: 'Mica (tinta do papel de parede)', material: 'acrylic', discord: '72%' },
	solido: { rotulo: 'Sólido (sem transparência)', material: 'none', discord: null }
};
// Glass escuro é o visual PADRÃO; migra a pref antiga booleana (glass: true/false).
function temaInicial() {
	if (!SUPORTA_GLASS) return 'solido';
	const p = lerPrefs();
	if (TEMAS[p.tema]) return p.tema;
	if (p.glass === false) return 'solido';
	return 'glass-dark';
}
let tema = temaInicial();
const ehGlass = () => TEMAS[tema].material !== 'none';
const COR_JANELA_SOLIDA = '#1e1f22';
const COR_TRANSPARENTE = '#00000000';

if (!app.requestSingleInstanceLock()) {
	app.quit();
}

const EMAIL_LOCAL = 'patricknicoli55@gmail.com'; // dono, quando não há login
const PARTICAO_DISCORD = 'persist:selfdiscord';
const UA_CHROME =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ALTURA_BARRA = 36;

// CSS injetado no painel: remove a moldura de janela falsa (não duplica a janela
// real do Electron). No modo sem login também esconde o botão de logout.
const CSS_PAINEL_BASE = `
	.titlebar { display: none !important; }
	.window {
		max-width: none !important; width: 100vw !important; height: 100vh !important;
		border: 0 !important; border-radius: 0 !important; box-shadow: none !important; margin: 0 !important;
	}
	html, body { background: var(--bg-window, #16161c) !important; padding: 0 !important; margin: 0 !important; }
	#ap-animbg, body.ap-animbg-on #ap-animbg { display: none !important; }
	/* A aba Aparência não funciona no app local (fundo/aurora são sobrescritos por
	   esta injeção) — escondida aqui; a aparência do app fica no menu de contas. */
	.nav-item[data-page="aparencia"], #page-aparencia { display: none !important; }
`;
// Sempre escondemos os botões de logout do painel — no modo com login o "sair"
// fica no menu da barra do topo (mais limpo, não polui o painel).
const CSS_SEM_LOGOUT = `#nav-logout, #conta-sair { display: none !important; }`;
const CSS_PAINEL = CSS_PAINEL_BASE + CSS_SEM_LOGOUT;

// Modo glass no painel: o body fica transparente e o acrylic da janela (blur do
// desktop) aparece atrás das superfícies rgba que o painel já usa. Vem DEPOIS do
// CSS_PAINEL na mesma injeção, então vence o background do body de lá.
// - body::before/::after: camadas de aurora/imagem de fundo que cobririam o vidro.
// - backdrop-filter do .window: sobre janela transparente o Chromium não tem o que
//   borrar (vira caixa preta em alguns drivers); o blur do desktop já vem do acrylic.
const CSS_PAINEL_TRANSPARENTE = `
	html, body { background: transparent !important; }
	body::before, body::after { display: none !important; }
	.window {
		backdrop-filter: none !important;
		-webkit-backdrop-filter: none !important;
	}
`;
const CSS_PAINEL_GLASS_ESCURO =
	CSS_PAINEL_TRANSPARENTE +
	`
	:root {
		--bg-window: rgba(24, 24, 30, 0.28) !important;
		--bg-sidebar: rgba(18, 18, 24, 0.20) !important;
		--bg-card: rgba(255, 255, 255, 0.055) !important;
		--bg-card-hover: rgba(255, 255, 255, 0.10) !important;
		--bg-input: rgba(255, 255, 255, 0.07) !important;
		--border: rgba(255, 255, 255, 0.09) !important;
	}
`;
// Mica emulado: tinte escuro moderado sobre o acrylic — meio-termo entre o Glass
// (bem transparente) e o Sólido: o papel de parede aparece, mas contido.
const CSS_PAINEL_MICA =
	CSS_PAINEL_TRANSPARENTE +
	`
	:root {
		--bg-window: rgba(28, 28, 34, 0.62) !important;
		--bg-sidebar: rgba(20, 20, 26, 0.56) !important;
		--bg-card: rgba(255, 255, 255, 0.05) !important;
		--bg-card-hover: rgba(255, 255, 255, 0.09) !important;
		--border: rgba(255, 255, 255, 0.08) !important;
	}
`;
// CSS extra injetado no painel conforme o tema ('' = sem extra, tema sólido).
const CSS_PAINEL_POR_TEMA = {
	'glass-dark': CSS_PAINEL_GLASS_ESCURO,
	mica: CSS_PAINEL_MICA,
	solido: ''
};

// Modo glass no Discord web (estilo Glasscord). Em vez de chutar nomes de variáveis
// (o Discord renomeia toda hora), o script varre as próprias folhas de estilo dele,
// coleta TODA variável de fundo (--background-*/--bg-*) definida em :root/.theme-*,
// e reemite cada uma misturada com transparente (color-mix) — ou seja, mantém a cor
// original do tema, só translúcida. Se o CSS ainda não carregou (SPA), tenta de novo.
const JS_DISCORD_GLASS = (opacidade) => `(function(){
	if (window.__pkGlass) return; window.__pkGlass = true;
	var ALVO = /^--bg-|background/i;
	var SELETOR = /:root|theme-dark|theme-darker|theme-midnight|theme-light|visual-refresh/;
	var tentativas = 0;
	function coletar(){
		var mapa = {};
		for (var i = 0; i < document.styleSheets.length; i++) {
			var regras; try { regras = document.styleSheets[i].cssRules; } catch (e) { continue; }
			if (!regras) continue;
			for (var j = 0; j < regras.length; j++) {
				var r = regras[j];
				if (!r.style || !r.selectorText || !SELETOR.test(r.selectorText)) continue;
				for (var k = 0; k < r.style.length; k++) {
					var p = r.style[k];
					if (ALVO.test(p)) mapa[p] = r.style.getPropertyValue(p).trim();
				}
			}
		}
		return mapa;
	}
	function aplicar(){
		var mapa = coletar();
		var nomes = Object.keys(mapa);
		if (nomes.length < 5) {
			if (++tentativas < 20) setTimeout(aplicar, 600);
			return;
		}
		var comp = getComputedStyle(document.documentElement);
		// Menus/modais/tooltips ficam quase opacos (senão viram vidro ilegível
		// flutuando sobre vidro); as superfícies grandes é que viram vidro.
		var FLUTUANTE = /floating|modal|popout|tooltip|menu|toast/i;
		var linhas = 'html, body, #app-mount { background: transparent !important; }\\n' +
			':root, .theme-dark, .theme-darker, .theme-midnight, .visual-refresh {';
		nomes.forEach(function(n){
			var v = (comp.getPropertyValue(n) || '').trim() || mapa[n];
			if (!v || v === 'transparent' || v === 'none') return;
			var pct = FLUTUANTE.test(n) ? '88%' : '${opacidade}';
			linhas += n + ':color-mix(in srgb, ' + v + ' ' + pct + ', transparent) !important;';
		});
		linhas += '}';
		var el = document.getElementById('pk-glass') || document.createElement('style');
		el.id = 'pk-glass';
		el.textContent = linhas;
		document.documentElement.appendChild(el);
	}
	aplicar();
})();`;

// Reforço via JS: remove os botões de logout do painel. Feito algumas vezes com
// timeout pra pegar render tardio — SEM MutationObserver contínuo (que engasgava
// o app a cada clique/re-render). O botão é criado uma vez no load; isso basta.
const JS_SEM_LOGOUT = `(function(){
	function limpar(){
		['nav-logout','conta-sair'].forEach(function(id){
			var e = document.getElementById(id); if (e) { e.remove(); }
		});
	}
	limpar();
	[300, 900, 2000].forEach(function(t){ setTimeout(limpar, t); });
})();`;

let janela = null;
let vista = null;
let urlPainel = null;
let contaAtual = null;
let emailLogado = OAUTH_ON ? null : EMAIL_LOCAL; // no modo login, descoberto após entrar

async function iniciarBackend() {
	const { criarConfig, sincronizarVersaoRPC } = require('../src/config/configuracao');
	const { iniciarServidorWebUI } = require('../src/services/web-ui-server');
	const { reconectarSessoesSalvas } = require('../src/services/user-context');
	const { inicializarRPC } = require('../src/services/rpc');

	criarConfig();
	sincronizarVersaoRPC();
	inicializarRPC().catch(() => {});
	const { url } = await iniciarServidorWebUI();
	reconectarSessoesSalvas().catch(() => {});
	// VPN: liga sozinha se o dono marcou "Ligar ao abrir o GoatCord" na aba VPN
	require('../src/services/vpn').aoIniciar().catch((e) => console.warn('[app] VPN automática:', e && e.message));
	return url;
}

async function listarContas() {
	if (!emailLogado) return [];
	try {
		const { listarTokensComValor } = require('../src/services/user-context');
		const lista = await listarTokensComValor(emailLogado);
		return Array.isArray(lista) ? lista.filter((t) => t && t.token) : [];
	} catch {
		return [];
	}
}

function ajustarVista() {
	if (!janela || !vista) return;
	const [w, h] = janela.getContentSize();
	vista.setBounds({ x: 0, y: ALTURA_BARRA, width: w, height: Math.max(0, h - ALTURA_BARRA) });
}

// Após navegar no painel, descobre quem está logado (email) pra listar os tokens
// certos e mostrar o nome na barra. Só relevante no modo com login.
async function capturarLogin() {
	if (!OAUTH_ON || !vista) return;
	try {
		const js = `fetch('/api/auth/site/me').then(r=>r.json()).then(j=>j&&j.sucesso?j.usuario:null).catch(()=>null)`;
		const u = await vista.webContents.executeJavaScript(js, true);
		if (u && u.email) {
			emailLogado = u.email;
			const nome = (u.usuario || u.email || '').split('@')[0];
			janela.webContents.send('account', nome);
		} else {
			emailLogado = null;
			janela.webContents.send('account', null);
		}
	} catch {}
}

function criarJanela() {
	janela = new BrowserWindow({
		width: 1280,
		height: 860,
		minWidth: 940,
		minHeight: 600,
		title: 'GoatCord',
		backgroundColor: ehGlass() ? COR_TRANSPARENTE : COR_JANELA_SOLIDA,
		backgroundMaterial: TEMAS[tema].material,
		frame: false,
		titleBarStyle: 'hidden',
		show: false,
		icon: path.join(__dirname, 'icon.ico'),
		webPreferences: {
			preload: path.join(__dirname, 'preload-titlebar.js'),
			contextIsolation: true,
			nodeIntegration: false,
			devTools: DEVTOOLS
		}
	});

	janela.loadFile(path.join(__dirname, 'titlebar.html'));
	janela.webContents.once('did-finish-load', () => janela.webContents.send('glass', tema));
	janela.once('ready-to-show', () => janela.show());

	vista = new BrowserView({
		webPreferences: {
			partition: PARTICAO_DISCORD,
			contextIsolation: true,
			nodeIntegration: false,
			spellcheck: false,
			devTools: DEVTOOLS
		}
	});
	janela.setBrowserView(vista);
	vista.webContents.setUserAgent(UA_CHROME);
	if (ehGlass()) {
		try {
			vista.setBackgroundColor(COR_TRANSPARENTE);
		} catch {}
	}
	ajustarVista();

	// Ao carregar o painel local: tira a moldura falsa e (modo login) descobre o usuário.
	// Nos temas glass/mica também injeta a transparência (painel e Discord).
	vista.webContents.on('dom-ready', () => {
		const u = vista.webContents.getURL();
		if (urlPainel && u.startsWith(urlPainel)) {
			vista.webContents.insertCSS(CSS_PAINEL + (CSS_PAINEL_POR_TEMA[tema] || '')).catch(() => {});
			vista.webContents.executeJavaScript(JS_SEM_LOGOUT).catch(() => {});
			capturarLogin();
		} else if (ehGlass() && /discord\.com/i.test(u)) {
			vista.webContents.executeJavaScript(JS_DISCORD_GLASS(TEMAS[tema].discord)).catch(() => {});
		}
	});

	// Só recarrega se o renderizador REALMENTE crashar (não em 'unresponsive', que
	// dispara à toa em página pesada e vira loop de reload = engasgo). Guard contra
	// tempestade de reloads: no máx algumas tentativas.
	let reloadsCrash = 0;
	vista.webContents.on('render-process-gone', (_e, det) => {
		console.error('[app] render-process-gone:', det && det.reason);
		if (det && det.reason !== 'clean-exit' && reloadsCrash < 2) {
			reloadsCrash++;
			setTimeout(() => {
				try {
					vista.webContents.reload();
				} catch {}
			}, 800);
		}
	});

	janela.on('resize', ajustarVista);
	janela.on('maximize', ajustarVista);
	janela.on('unmaximize', ajustarVista);

	vista.webContents.setWindowOpenHandler(({ url: alvo }) => {
		if (/^https?:/i.test(alvo) && !/discord\.com/i.test(alvo) && (!urlPainel || !alvo.startsWith(urlPainel))) {
			shell.openExternal(alvo);
			return { action: 'deny' };
		}
		return { action: 'allow' };
	});

	janela.on('closed', () => {
		janela = null;
		vista = null;
	});
}

// Conecta a conta ativa ao GATEWAY em segundo plano, pra o Rich Presence rodar
// enquanto o dono usa o Discord web (que é uma sessão SEPARADA do gateway — como
// ter o Discord aberto no celular e no PC). Sem isto o RPC nunca aparece no app
// local, já que reconectarSessoesSalvas() é no-op sem Supabase. Trocar de conta
// derruba a sessão anterior antes de subir a nova, então o RPC segue a conta em uso.
let tokenGatewayAtivo = null;
let sincronizandoGateway = false;
let contaGatewayDesejada = null;
async function sincronizarGatewayRPC(conta) {
	if (!conta || !conta.token || !emailLogado) return;
	contaGatewayDesejada = conta;
	if (conta.token === tokenGatewayAtivo) return; // já conectado nesta conta
	if (sincronizandoGateway) return; // o loop em andamento pega a conta desejada
	sincronizandoGateway = true;
	try {
		const { obterContexto } = require('../src/services/user-context');
		const ctx = obterContexto(emailLogado);
		// Reprocessa enquanto a conta desejada mudar no meio de uma conexão (troca rápida).
		while (contaGatewayDesejada && contaGatewayDesejada.token !== tokenGatewayAtivo) {
			const alvo = contaGatewayDesejada;
			// Troca "quente": mantém as funções do self (automute, comandos de
			// prefixo, tarefas/farm, RPC) rodando e só reaponta pro novo token,
			// sem derrubar tudo. Faz make-before-break (conecta antes de derrubar).
			const r = await ctx.trocarToken(alvo.token); // aplica o Rich Presence ao conectar
			if (r && r.sucesso) {
				tokenGatewayAtivo = alvo.token;
				console.log('[app] gateway/RPC ativo:', r.usuario && r.usuario.tag);
			} else {
				console.warn('[app] gateway/RPC falhou:', r && r.mensagem);
				break; // token inválido/expirado: não fica em loop
			}
		}
	} catch (e) {
		console.warn('[app] gateway/RPC erro:', e && e.message);
	} finally {
		sincronizandoGateway = false;
	}
}

// Loga o Discord web como o self da conta escolhida. O Discord tira o acesso ao
// localStorage da janela principal, então gravamos via IFRAME (mesmo domínio).
function abrirDiscordSelf(conta) {
	if (!janela) return;
	contaAtual = conta.nome;
	janela.webContents.send('account', conta.nome);

	const wc = vista.webContents;
	const injecao = `(function(){
		var TOKEN = ${JSON.stringify(conta.token)};
		function gravar(){
			try {
				var f = document.createElement('iframe');
				(document.body || document.documentElement).appendChild(f);
				f.contentWindow.localStorage.setItem('token', '"' + TOKEN + '"');
				f.remove();
				return true;
			} catch (e) { return false; }
		}
		gravar();
		var n = 0;
		var iv = setInterval(function(){
			gravar();
			if (++n >= 6) {
				clearInterval(iv);
				if (!/\\/channels\\//.test(location.pathname)) location.replace('https://discord.com/channels/@me');
			}
		}, 200);
	})();`;
	wc.once('dom-ready', () => wc.executeJavaScript(injecao).catch(() => {}));
	wc.loadURL('https://discord.com/login');

	// Conecta a mesma conta ao gateway em background pro Rich Presence rodar
	// enquanto o self é usado. Pequeno atraso pra o Discord web carregar primeiro
	// e não disputar o event loop no arranque.
	setTimeout(() => sincronizarGatewayRPC(conta), 2000);
}

function abrirPainel() {
	if (!janela) return;
	contaAtual = null;
	if (!OAUTH_ON) janela.webContents.send('account', null);
	if (urlPainel) vista.webContents.loadURL(urlPainel);
}

// Abre a tela de configuração do Rich Presence (servida pelo backend, na mesma
// origem do painel — a sessão/cookie vai junto).
function abrirRPC() {
	if (!janela || !vista || !urlPainel) return;
	contaAtual = null;
	if (!OAUTH_ON) janela.webContents.send('account', null);
	vista.webContents.loadURL(urlPainel.replace(/\/$/, '') + '/rpc');
}

// Abre o Sniper de usernames, servido pelo backend na mesma origem do painel.
function abrirSniper() {
	if (!janela || !vista || !urlPainel) return;
	contaAtual = null;
	if (!OAUTH_ON) janela.webContents.send('account', null);
	vista.webContents.loadURL(urlPainel.replace(/\/$/, '') + '/sniper');
}

// Abre a tela de "Convidar amigos" (group DMs), servida pelo backend na mesma
// origem do painel (a sessão/cookie vai junto).
function abrirConvites() {
	if (!janela || !vista || !urlPainel) return;
	contaAtual = null;
	if (!OAUTH_ON) janela.webContents.send('account', null);
	vista.webContents.loadURL(urlPainel.replace(/\/$/, '') + '/convites');
}

// Abre a tela de Backup de conta, servida pelo backend na mesma origem do painel.
function abrirBackup() {
	if (!janela || !vista || !urlPainel) return;
	contaAtual = null;
	if (!OAUTH_ON) janela.webContents.send('account', null);
	vista.webContents.loadURL(urlPainel.replace(/\/$/, '') + '/backup');
}

// Abre a aba VPN (túnel dividido) do painel — src/services/vpn.js.
function abrirVPN() {
	if (!janela || !vista || !urlPainel) return;
	contaAtual = null;
	if (!OAUTH_ON) janela.webContents.send('account', null);
	vista.webContents.loadURL(urlPainel.replace(/\/$/, '') + '/#vpn');
}

// Sair da conta (só no modo com login): volta pro painel, chama o logout no
// servidor (remove sessão + limpa cookie) e cai na tela de login.
function sairLogin() {
	if (!vista || !urlPainel) return;
	emailLogado = null;
	contaAtual = null;
	const wc = vista.webContents;
	const feito = () => {
		wc.executeJavaScript(
			"fetch('/api/auth/site/logout',{method:'POST'}).catch(()=>{}).then(()=>location.replace('/'))"
		).catch(() => {});
	};
	wc.once('did-finish-load', feito);
	wc.loadURL(urlPainel);
}

// Aplica um tema em tempo real: troca o material da janela, avisa a titlebar e
// recarrega a vista (o CSS injetado só entra/sai no dom-ready).
function aplicarTema(novo) {
	if (!SUPORTA_GLASS || !janela || !TEMAS[novo] || novo === tema) return;
	tema = novo;
	salvarPrefs({ tema });
	try {
		janela.setBackgroundMaterial(TEMAS[tema].material);
	} catch {}
	try {
		janela.setBackgroundColor(ehGlass() ? COR_TRANSPARENTE : COR_JANELA_SOLIDA);
	} catch {}
	if (vista) {
		try {
			vista.setBackgroundColor(ehGlass() ? COR_TRANSPARENTE : COR_JANELA_SOLIDA);
		} catch {}
	}
	janela.webContents.send('glass', tema);
	if (vista) {
		try {
			vista.webContents.reload();
		} catch {}
	}
}

async function mostrarMenuContas() {
	const contas = await listarContas();
	const itens = contas.length
		? contas.map((c) => ({
				label: c.nome,
				type: 'radio',
				checked: c.nome === contaAtual,
				click: () => abrirDiscordSelf(c)
			}))
		: [{ label: emailLogado ? '(nenhuma conta salva)' : '(faça login primeiro)', enabled: false }];

	const menu = Menu.buildFromTemplate([
		...itens,
		{ type: 'separator' },
		{ label: OAUTH_ON ? 'Painel' : 'Gerenciar contas (adicionar/remover)', click: () => abrirPainel() },
		{ label: 'Rich Presence', click: () => abrirRPC() },
		{ label: 'Sniper de usernames', click: () => abrirSniper() },
		{ label: 'Convidar amigos', click: () => abrirConvites() },
		{ label: 'Backup de conta', click: () => abrirBackup() },
		...(process.platform === 'win32' ? [{ label: 'VPN', click: () => abrirVPN() }] : []),
		...(SUPORTA_GLASS
			? [
					{
						label: 'Aparência',
						submenu: Object.keys(TEMAS).map((t) => ({
							label: TEMAS[t].rotulo,
							type: 'radio',
							checked: t === tema,
							click: () => aplicarTema(t)
						}))
					}
				]
			: []),
		{ label: 'Recarregar', click: () => vista && vista.webContents.reload() },
		...(DEVTOOLS
			? [{ label: 'Ferramentas de desenvolvedor', click: () => vista && vista.webContents.toggleDevTools() }]
			: []),
		...(OAUTH_ON ? [{ type: 'separator' }, { label: 'Sair da conta (trocar login)', click: () => sairLogin() }] : [])
	]);
	menu.popup({ window: janela });
}

ipcMain.on('win-action', (_e, acao) => {
	if (!janela) return;
	if (acao === 'close') janela.close();
	else if (acao === 'min') janela.minimize();
	else if (acao === 'max') janela.isMaximized() ? janela.unmaximize() : janela.maximize();
});

ipcMain.on('accounts-menu', () => mostrarMenuContas());

app.on('second-instance', () => {
	if (janela) {
		if (janela.isMinimized()) janela.restore();
		janela.focus();
	}
});

app.whenReady().then(async () => {
	Menu.setApplicationMenu(null);

	// Libera câmera, microfone e outros recursos de mídia para o Discord web.
	// Sem isso o Electron bloqueia silenciosamente e o Discord não consegue
	// listar nem usar nenhum dispositivo de áudio/vídeo.
	const sesDiscord = session.fromPartition(PARTICAO_DISCORD);
	sesDiscord.setPermissionRequestHandler((_wc, permission, callback) => {
		// 'video_capture' / 'audio_capture' são os tipos internos do Chromium
		// para câmera e microfone; 'media' é o tipo genérico do Electron.
		const PERMITIDAS = [
			'media', 'video_capture', 'audio_capture',
			'mediaKeySystem', 'display-capture', 'fullscreen',
			'notifications', 'geolocation'
		];
		callback(PERMITIDAS.includes(permission));
	});
	sesDiscord.setPermissionCheckHandler((_wc, permission) => {
		return [
			'media', 'video_capture', 'audio_capture',
			'mediaKeySystem', 'display-capture', 'fullscreen'
		].includes(permission);
	});

	try {
		urlPainel = await iniciarBackend();
		criarJanela();

		janela.webContents.once('did-finish-load', async () => {
			if (OAUTH_ON) {
				// Exige login: sempre começa no painel (que manda pro /login se preciso).
				abrirPainel();
			} else {
				const contas = await listarContas();
				if (contas.length === 0) abrirPainel();
				else abrirDiscordSelf(contas[0]);
			}
		});
	} catch (erro) {
		console.error('[app] ERRO FATAL:', (erro && erro.stack) || erro);
		dialog.showErrorBox('GoatCord — erro ao iniciar', String((erro && erro.stack) || erro));
		app.quit();
	}

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) app.whenReady();
	});
});

app.on('window-all-closed', () => app.quit());

// "Desligar a VPN ao fechar o GoatCord" (padrão ligado): o túnel roda no serviço
// do WireSock e ficaria ativo sem o app aberto.
app.on('will-quit', () => {
	try {
		require('../src/services/vpn').aoFechar();
	} catch {}
});
