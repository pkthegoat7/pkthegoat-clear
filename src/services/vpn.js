'use strict';

// ===== VPN com túnel dividido (aba "VPN" do painel) =====
// Porta para Node do TunelSplit (C:\Users\patri\TunelSplit\Engine.cs). Controla o
// WireSock Secure Connect pelo wiresock-connect-cli.exe: o túnel roda no serviço do
// WireSock e aqui só importamos o perfil, conectamos e desconectamos.
//
// Usa a MESMA pasta e o mesmo settings.json do TunelSplit (%APPDATA%\TunelSplit),
// então servidores e apps marcados valem nos dois.
//
// Administrador: o CLI do WireSock funciona sem admin; só o ajuste de MTU (netsh)
// precisa. Para não pedir UAC a cada conexão, criamos UMA vez a tarefa agendada
// "\GoatCord\VPN MTU", com privilégio elevado, que roda apenas o comando fixo do
// netsh. Ela não executa nenhum arquivo do usuário.

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const PERFIL = 'TunelSplit';
const SONDA = 'tunelsplit-probe'; // cópia do curl que sempre passa pelo túnel
const REDES_LOCAIS = '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16';
const MTU = 1380;
const TAREFA_MTU = '\\GoatCord\\VPN MTU';
const TEMPO_TESTE_SERVIDOR_MS = 20000;

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DIR = path.join(APPDATA, 'TunelSplit');
const DIR_SERVIDORES = path.join(DIR, 'servers');
const ARQ_CONFIG = path.join(DIR, 'settings.json');
const ARQ_PERFIL = path.join(DIR, PERFIL + '.conf');
const ARQ_SONDA = path.join(DIR, SONDA + '.exe');
const ARQ_PREFS = path.join(process.env.PKTHEGOAT_HOME || path.join(APPDATA, 'GoatCord'), 'vpn.json');
const DOWNLOADS = path.join(os.homedir(), 'Downloads');

const suportado = process.platform === 'win32';

// ---------- utilitários ----------

function rodar(exe, args, tempoMs = 15000) {
	return new Promise((resolve) => {
		execFile(exe, args, { windowsHide: true, timeout: tempoMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (erro, out, err) => {
			const saida = `${out || ''}${err || ''}`.trim();
			resolve({ codigo: erro ? (typeof erro.code === 'number' ? erro.code : 1) : 0, saida });
		});
	});
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function lerJson(arq, padrao) {
	try {
		return JSON.parse(fs.readFileSync(arq, 'utf8'));
	} catch {
		return padrao;
	}
}

// ---------- configuração (compatível com o TunelSplit) ----------

function lerConfig() {
	const c = lerJson(ARQ_CONFIG, {}) || {};
	const modo = c.Mode === 1 || c.Mode === 'AllExceptSelected' ? 'exceto' : 'so';
	return {
		modo,
		apps: Array.isArray(c.Apps) ? c.Apps.filter((a) => typeof a === 'string' && a) : [],
		servidor: typeof c.SelectedServer === 'string' ? c.SelectedServer : null
	};
}

function salvarConfig(cfg) {
	fs.mkdirSync(DIR, { recursive: true });
	const json = { Mode: cfg.modo === 'exceto' ? 1 : 0, Apps: cfg.apps, SelectedServer: cfg.servidor };
	fs.writeFileSync(ARQ_CONFIG, JSON.stringify(json, null, 2));
}

function lerPrefs() {
	const p = lerJson(ARQ_PREFS, {}) || {};
	return { autoConectar: !!p.autoConectar, desligarAoFechar: p.desligarAoFechar !== false };
}

function salvarPrefs(mudanca) {
	const p = { ...lerPrefs(), ...mudanca };
	fs.mkdirSync(path.dirname(ARQ_PREFS), { recursive: true });
	fs.writeFileSync(ARQ_PREFS, JSON.stringify(p, null, 2));
	return p;
}

// ---------- motor WireSock ----------

let _cliCache;
function acharCli() {
	if (_cliCache && fs.existsSync(_cliCache)) return _cliCache;
	_cliCache = null;
	const raizes = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
	const procurar = (dir, prof) => {
		let itens = [];
		try {
			itens = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return null;
		}
		for (const i of itens) {
			const p = path.join(dir, i.name);
			if (i.isFile() && i.name.toLowerCase() === 'wiresock-connect-cli.exe') return p;
		}
		if (prof <= 0) return null;
		for (const i of itens) {
			if (i.isDirectory()) {
				const r = procurar(path.join(dir, i.name), prof - 1);
				if (r) return r;
			}
		}
		return null;
	};
	for (const raiz of raizes) {
		let dirs = [];
		try {
			dirs = fs.readdirSync(raiz).filter((n) => /^wiresock/i.test(n));
		} catch {}
		for (const d of dirs) {
			const r = procurar(path.join(raiz, d), 3);
			if (r) return (_cliCache = r);
		}
	}
	return null;
}

function cli() {
	const c = acharCli();
	if (!c) throw new Error('O motor WireSock não está instalado. Clique em "Instalar motor".');
	return c;
}

function acharWinget() {
	const alias = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'winget.exe');
	return fs.existsSync(alias) ? alias : 'winget';
}

// ---------- servidores ----------

function ehConfigWireGuard(texto) {
	return /\[Interface\]/.test(texto) && /PrivateKey/.test(texto) && /\[Peer\]/.test(texto);
}

// A Proton escreve o nome do servidor como comentário logo abaixo de [Peer], ex.: "# US-FREE#143"
function infoServidor(texto, nomeArquivo) {
	let nome = null;
	let noPeer = false;
	for (const bruta of texto.split(/\r?\n/)) {
		const l = bruta.trim();
		if (l.startsWith('[')) noPeer = /^\[Peer\]$/i.test(l);
		else if (noPeer && l.startsWith('#')) {
			nome = l.replace(/^#+/, '').trim();
			break;
		}
	}
	nome = nome || path.basename(nomeArquivo, path.extname(nomeArquivo));
	const pais = (nome.match(/^[A-Za-z]{2}/) || [''])[0].toUpperCase();
	return { nome, pais };
}

function listarServidores() {
	let arquivos = [];
	try {
		arquivos = fs.readdirSync(DIR_SERVIDORES).filter((f) => f.toLowerCase().endsWith('.conf'));
	} catch {}
	return arquivos
		.map((arquivo) => {
			try {
				return { arquivo, ...infoServidor(fs.readFileSync(path.join(DIR_SERVIDORES, arquivo), 'utf8'), arquivo) };
			} catch {
				return null;
			}
		})
		.filter(Boolean)
		.sort((a, b) => a.pais.localeCompare(b.pais) || a.nome.localeCompare(b.nome));
}

/** Grava uma configuração WireGuard na pasta de servidores. Retorna o servidor, ou null se já existia. */
function importarTexto(texto, nomeOriginal = 'servidor.conf', sobrescrever = true) {
	texto = String(texto || '');
	if (texto.length > 64 * 1024 || !ehConfigWireGuard(texto)) {
		throw new Error(`"${nomeOriginal}" não é uma configuração WireGuard válida.`);
	}
	const info = infoServidor(texto, nomeOriginal);
	const arquivo = info.nome.replace(/[^A-Za-z0-9_-]/g, '-') + '.conf';
	const destino = path.join(DIR_SERVIDORES, arquivo);
	if (fs.existsSync(destino) && !sobrescrever) return null;
	fs.mkdirSync(DIR_SERVIDORES, { recursive: true });
	fs.writeFileSync(destino, texto);
	return { arquivo, ...info };
}

// Configurações baixadas do site da Proton entram sozinhas (igual ao TunelSplit)
let _ultimaVarredura = 0;
function importarDaPastaDownloads() {
	if (Date.now() - _ultimaVarredura < 5000) return [];
	_ultimaVarredura = Date.now();
	const novos = [];
	let arquivos = [];
	try {
		arquivos = fs.readdirSync(DOWNLOADS).filter((f) => f.toLowerCase().endsWith('.conf'));
	} catch {
		return novos;
	}
	for (const f of arquivos) {
		try {
			const texto = fs.readFileSync(path.join(DOWNLOADS, f), 'utf8');
			if (!ehConfigWireGuard(texto)) continue;
			const s = importarTexto(texto, f, false);
			if (s) novos.push(s);
		} catch {}
	}
	return novos;
}

function removerServidor(arquivo) {
	const nome = path.basename(String(arquivo || ''));
	if (!nome.toLowerCase().endsWith('.conf')) throw new Error('Servidor inválido.');
	fs.rmSync(path.join(DIR_SERVIDORES, nome), { force: true });
	const cfg = lerConfig();
	if (cfg.servidor === nome) {
		cfg.servidor = (listarServidores()[0] || {}).arquivo || null;
		salvarConfig(cfg);
	}
}

// ---------- apps ----------

const nomeProcesso = (p) => path.basename(String(p)).replace(/\.exe$/i, '');

function montarPerfil(cfg, servidor) {
	const porChave = new Map();
	for (const n of cfg.apps.map(nomeProcesso).filter(Boolean)) if (!porChave.has(n.toLowerCase())) porChave.set(n.toLowerCase(), n);
	const nomes = [...porChave.values()];
	if (cfg.modo === 'so' && nomes.length === 0) throw new Error('Marque pelo menos um app para passar pela VPN.');

	// O DNS da Proton (10.2.0.1) só responde dentro do túnel, mas quem resolve nomes no
	// Windows é um serviço do sistema que fica fora dele; por isso usamos o DNS normal.
	const linhas = fs
		.readFileSync(path.join(DIR_SERVIDORES, servidor.arquivo), 'utf8')
		.split(/\r?\n/)
		.filter((l) => !/^\s*(AllowedApps|DisallowedApps|DisallowedIPs|DNS)\s*=/i.test(l));
	const peer = linhas.findIndex((l) => /^\[Peer\]$/i.test(l.trim()));
	if (peer < 0) throw new Error('A configuração não tem a seção [Peer].');

	const extra = [];
	if (cfg.modo === 'so') {
		extra.push('AllowedApps = ' + [...nomes, SONDA].join(', '));
	} else {
		if (nomes.length) extra.push('DisallowedApps = ' + nomes.join(', '));
		extra.push('DisallowedIPs = ' + REDES_LOCAIS);
	}
	linhas.splice(peer + 1, 0, ...extra);
	return linhas.join('\r\n');
}

const _icones = new Map();
async function iconeDe(exe) {
	if (_icones.has(exe)) return _icones.get(exe);
	let url = null;
	try {
		const { app } = require('electron');
		if (app && app.getFileIcon) url = (await app.getFileIcon(exe, { size: 'normal' })).toDataURL();
	} catch {}
	_icones.set(exe, url);
	return url;
}

// Apps com janela aberta + os já marcados (mesma lista que o TunelSplit mostra)
async function listarApps() {
	const cfg = lerConfig();
	const script =
		'[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
		'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path } | ' +
		'Select-Object Path, Description -Unique | ConvertTo-Json -Compress';
	const r = await rodar('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 20000);
	let abertos = [];
	try {
		const j = JSON.parse(r.saida || '[]');
		abertos = Array.isArray(j) ? j : [j];
	} catch {}

	// Apps que se atualizam sozinhos (Discord: ...\app-1.0.9265\Discord.exe) mudam de pasta.
	// O WireSock filtra pelo nome do processo, então um caminho salvo que sumiu é trocado
	// pelo do app aberto com o mesmo nome, sem duplicar na lista.
	let migrou = false;
	cfg.apps = cfg.apps.map((p) => {
		if (fs.existsSync(p)) return p;
		const igual = abertos.find((a) => a && a.Path && nomeProcesso(a.Path).toLowerCase() === nomeProcesso(p).toLowerCase());
		if (!igual) return p;
		migrou = true;
		return igual.Path;
	});
	cfg.apps = cfg.apps.filter((p, i) => cfg.apps.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i);
	if (migrou) salvarConfig(cfg);

	const mapa = new Map();
	for (const p of cfg.apps) mapa.set(p.toLowerCase(), { caminho: p, nome: null, marcado: true, aberto: false });
	for (const a of abertos) {
		if (!a || !a.Path) continue;
		const k = a.Path.toLowerCase();
		const atual = mapa.get(k) || { caminho: a.Path, nome: null, marcado: false, aberto: false };
		atual.aberto = true;
		atual.nome = (a.Description || '').trim() || null;
		mapa.set(k, atual);
	}
	const lista = [...mapa.values()];
	for (const a of lista) {
		a.nome = a.nome || path.basename(a.caminho);
		a.icone = fs.existsSync(a.caminho) ? await iconeDe(a.caminho) : null;
	}
	return lista.sort((a, b) => b.marcado - a.marcado || a.nome.localeCompare(b.nome));
}

function acharDiscord() {
	const base = path.join(process.env.LOCALAPPDATA || '', 'Discord');
	let versoes = [];
	try {
		versoes = fs.readdirSync(base).filter((n) => /^app-[\d.]+$/.test(n));
	} catch {}
	const num = (n) => n.slice(4).split('.').map((x) => parseInt(x, 10) || 0);
	versoes.sort((a, b) => {
		const x = num(a);
		const y = num(b);
		for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
		return 0;
	});
	for (const v of versoes) {
		const exe = path.join(base, v, 'Discord.exe');
		if (fs.existsSync(exe)) return exe;
	}
	return null;
}

async function discordAberto() {
	const r = await rodar('tasklist', ['/FI', 'IMAGENAME eq Discord.exe', '/NH'], 8000);
	return /discord\.exe/i.test(r.saida);
}

async function reiniciarDiscord() {
	await rodar('taskkill', ['/IM', 'Discord.exe', '/F'], 10000);
	await esperar(1500);
	const update = path.join(process.env.LOCALAPPDATA || '', 'Discord', 'Update.exe');
	const exe = acharDiscord();
	const [cmd, args] = fs.existsSync(update) ? [update, ['--processStart', 'Discord.exe']] : [exe, []];
	if (!cmd) throw new Error('Discord não encontrado.');
	spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

// ---------- permissão de administrador (MTU) ----------

async function tarefaMtuExiste() {
	return (await rodar('schtasks', ['/Query', '/TN', TAREFA_MTU], 8000)).codigo === 0;
}

// Pede o UAC UMA vez e registra a tarefa elevada que só roda o netsh do MTU
async function configurarPermissao() {
	const usuario = `${process.env.USERDOMAIN || os.hostname()}\\${os.userInfo().username}`.replace(/'/g, "''");
	const arg = (v) => `interface ${v} set subinterface "${PERFIL}" mtu=${MTU} store=active`;
	const interno = [
		`$a1 = New-ScheduledTaskAction -Execute 'netsh.exe' -Argument '${arg('ipv4')}'`,
		`$a2 = New-ScheduledTaskAction -Execute 'netsh.exe' -Argument '${arg('ipv6')}'`,
		`$p = New-ScheduledTaskPrincipal -UserId '${usuario}' -LogonType S4U -RunLevel Highest`,
		'$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 1)',
		"Register-ScheduledTask -TaskPath '\\GoatCord\\' -TaskName 'VPN MTU' -Action $a1,$a2 -Principal $p -Settings $s -Force | Out-Null"
	].join('; ');
	const codificado = Buffer.from(interno, 'utf16le').toString('base64');
	const externo =
		"$ErrorActionPreference='Stop'; Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden " +
		`-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${codificado}'`;
	await rodar('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', externo], 120000);
	if (!(await tarefaMtuExiste())) {
		throw new Error('A permissão não foi concedida (o pedido de administrador foi recusado?).');
	}
}

async function mtuAtual() {
	const r = await rodar('netsh', ['interface', 'ipv4', 'show', 'subinterface', PERFIL], 8000);
	if (r.codigo !== 0) return null;
	const m = r.saida.match(/^\s*(\d{3,5})\s+\d+/m);
	return m ? parseInt(m[1], 10) : null;
}

// O adaptador do WireSock sobe com MTU 1500 e ignora o "MTU =" do perfil. Somado ao cabeçalho
// do WireGuard, pacotes grandes são descartados e só tráfego pequeno passa (sites e Discord travam).
async function corrigirMtu() {
	const temTarefa = await tarefaMtuExiste();
	for (let i = 0; i < 20; i++) {
		const atual = await mtuAtual();
		if (atual === MTU) return;
		if (atual !== null) {
			// Adaptador já existe: tenta direto (GoatCord aberto como admin) e, senão, pela tarefa
			const direto = await rodar('netsh', ['interface', 'ipv4', 'set', 'subinterface', PERFIL, `mtu=${MTU}`, 'store=active'], 10000);
			if (direto.codigo === 0) {
				await rodar('netsh', ['interface', 'ipv6', 'set', 'subinterface', PERFIL, `mtu=${MTU}`, 'store=active'], 10000);
				return;
			}
			if (!temTarefa) {
				throw new Error('Falta a permissão de administrador para ajustar a rede. Clique em "Dar permissão" e conecte de novo.');
			}
			await rodar('schtasks', ['/Run', '/TN', TAREFA_MTU], 10000);
		}
		await esperar(1000);
	}
	throw new Error('Não consegui ajustar o MTU do adaptador, então desconectei (sem isso sites e Discord não carregam).');
}

// ---------- túnel ----------

const estado = {
	fase: 'desligado', // desligado | conectando | aguardando | conectado | desconectando | instalando | permissao
	mensagem: '',
	servidor: null,
	local: null,
	atualizadoEm: Date.now()
};
let _execucao = 0;
let _ocupado = null; // promessa da operação em andamento

function definir(mudanca) {
	Object.assign(estado, mudanca, { atualizadoEm: Date.now() });
}

async function iniciarTunel(cfg, servidor) {
	const c = cli();
	fs.mkdirSync(DIR, { recursive: true });
	fs.writeFileSync(ARQ_PERFIL, montarPerfil(cfg, servidor));
	try {
		// Recria o perfil para refletir servidor, apps e modo atuais
		await rodar(c, ['delete', PERFIL], 15000);
		const imp = await rodar(c, ['import', ARQ_PERFIL], 15000);
		if (imp.codigo !== 0) throw new Error('Falha ao importar o perfil: ' + imp.saida);
	} finally {
		// O WireSock guarda a própria cópia; não deixamos outra cópia da chave privada por aí
		fs.rmSync(ARQ_PERFIL, { force: true });
	}
	// -lac: adaptador virtual (o modo transparente não passava tráfego nesta máquina)
	// Servidores Proton gratuitos podem demorar 90-120s no handshake; 180s de margem.
	const con = await rodar(c, ['connect', PERFIL, '-lac', '-log-level', 'error', '-exit'], 180000);
	if (con.codigo !== 0) throw new Error('Falha ao conectar: ' + con.saida);
	try {
		await corrigirMtu();
	} catch (e) {
		await pararTunel();
		throw e;
	}
}

async function pararTunel() {
	const c = acharCli();
	if (c) await rodar(c, ['disconnect'], 15000);
}

async function tunelAtivo() {
	const c = acharCli();
	if (!c) return false;
	const r = await rodar(c, ['status'], 15000);
	return new RegExp(PERFIL, 'i').test(r.saida);
}

/** IP de saída medido por dentro do túnel; null enquanto o tráfego ainda não passa. */
async function sondarLocal() {
	const curl = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');
	if (!fs.existsSync(curl)) return null;
	try {
		if (!fs.existsSync(ARQ_SONDA) || fs.statSync(ARQ_SONDA).size !== fs.statSync(curl).size) {
			fs.mkdirSync(DIR, { recursive: true });
			fs.copyFileSync(curl, ARQ_SONDA);
		}
	} catch {}
	const r = await rodar(ARQ_SONDA, ['-s', '-m', '6', 'https://ipinfo.io/json'], 10000);
	if (r.codigo !== 0) return null;
	try {
		const j = JSON.parse(r.saida);
		return j.ip ? { ip: j.ip, cidade: j.city || '', pais: j.country || '' } : null;
	} catch {
		return null;
	}
}

async function aguardarTrafego(execucao, tempoMs) {
	const limite = Date.now() + tempoMs;
	while (Date.now() < limite && execucao === _execucao) {
		const local = await sondarLocal();
		if (execucao !== _execucao) return false;
		if (local) {
			definir({ local });
			return true;
		}
		await esperar(2000);
	}
	return false;
}

// Tenta o servidor escolhido e, se ele não passar tráfego, os outros (primeiro os do mesmo país)
async function rotinaConectar(execucao) {
	const cfg = lerConfig();
	const servidores = listarServidores();
	const primeiro = servidores.find((s) => s.arquivo === cfg.servidor) || servidores[0];
	if (!primeiro) {
		definir({ fase: 'desligado', mensagem: 'Nenhum servidor. Baixe uma configuração WireGuard da Proton (botão "Mais países").' });
		return;
	}
	const candidatos = [primeiro, ...servidores.filter((s) => s.arquivo !== primeiro.arquivo).sort((a, b) => (a.pais === primeiro.pais ? 0 : 1) - (b.pais === primeiro.pais ? 0 : 1))];

	for (const servidor of candidatos) {
		if (execucao !== _execucao) return;
		definir({ fase: 'conectando', servidor: servidor.arquivo, local: null, mensagem: `Conectando em ${servidor.nome}…` });
		try {
			await iniciarTunel(cfg, servidor);
		} catch (e) {
			if (execucao !== _execucao) return;
			definir({ mensagem: `${servidor.nome} não conectou; tentando outro servidor…` });
			continue;
		}
		if (execucao !== _execucao) return;
		definir({ fase: 'aguardando', mensagem: 'O túnel está subindo — pode levar alguns segundos para liberar o tráfego.' });
		if (await aguardarTrafego(execucao, TEMPO_TESTE_SERVIDOR_MS)) {
			cfg.servidor = servidor.arquivo;
			salvarConfig({ ...lerConfig(), servidor: servidor.arquivo });
			const troca = servidor.arquivo !== primeiro.arquivo ? `${primeiro.nome} não respondeu; usando ${servidor.nome}. ` : '';
			definir({
				fase: 'conectado',
				mensagem:
					troca +
					(cfg.modo === 'so'
						? 'Pronto. Apps marcados que já estavam abertos precisam ser reabertos para entrar na VPN.'
						: 'Pronto. Os apps marcados e a rede local ficam fora da VPN.')
			});
			return;
		}
		if (execucao !== _execucao) return;
		definir({ mensagem: `${servidor.nome} não passou tráfego; tentando outro servidor…` });
		await pararTunel();
	}
	definir({
		fase: 'desligado',
		servidor: null,
		local: null,
		mensagem: 'Nenhum servidor passou tráfego agora. Os servidores grátis podem estar lotados — tente de novo em alguns minutos.'
	});
}

function conectar() {
	if (!suportado) throw new Error('VPN disponível só no Windows.');
	cli();
	const execucao = ++_execucao;
	_ocupado = (async () => {
		if (await tunelAtivo()) await pararTunel();
		await rotinaConectar(execucao);
	})().catch((e) => definir({ fase: 'desligado', mensagem: e.message }));
	return _ocupado;
}

async function desconectar() {
	_execucao++;
	definir({ fase: 'desconectando', mensagem: 'Desconectando…' });
	try {
		await pararTunel();
		definir({ fase: 'desligado', servidor: null, local: null, mensagem: 'Desconectado.' });
	} catch (e) {
		definir({ fase: 'desligado', mensagem: e.message });
	}
}

/** Reaplica servidor/apps/modo se o túnel estiver ligado. */
function reaplicarSeLigado() {
	if (['conectado', 'aguardando', 'conectando'].includes(estado.fase)) conectar();
}

async function instalarMotor() {
	definir({ fase: 'instalando', mensagem: 'Instalando o motor WireSock pelo winget… isso pode levar um minuto.' });
	const r = await rodar(
		acharWinget(),
		['install', '--id', 'NTKERNEL.WireSockVPNClient', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'],
		10 * 60000
	);
	_cliCache = null;
	definir({ fase: 'desligado', mensagem: acharCli() ? 'Motor instalado.' : `A instalação não terminou (código ${r.codigo}).` });
}

// ---------- latência dos servidores (ping) ----------

function extrairEndpointIp(arquivo) {
	try {
		const texto = fs.readFileSync(path.join(DIR_SERVIDORES, arquivo), 'utf8');
		const m = texto.match(/^\s*Endpoint\s*=\s*([\d.]+):/m);
		return m ? m[1] : null;
	} catch { return null; }
}

async function pingar(ip) {
	const r = await rodar('ping', ['-n', '1', '-w', '2000', ip], 5000);
	if (r.codigo !== 0) return null;
	const m = r.saida.match(/[Tt]ime[=<](\d+)ms/);
	return m ? parseInt(m[1], 10) : null;
}

let _cachePings = new Map();
let _cachePingsTs = 0;
let _pingsEmAndamento = false;
const CACHE_PINGS_MS = 30000;

function iniciarPings(servidores) {
	if (_pingsEmAndamento) return;
	_pingsEmAndamento = true;
	Promise.all(
		servidores.map(async (s) => {
			const ip = extrairEndpointIp(s.arquivo);
			const ms = ip ? await pingar(ip) : null;
			return [s.arquivo, ms];
		})
	).then((resultados) => {
		_cachePings = new Map(resultados);
		_cachePingsTs = Date.now();
		_pingsEmAndamento = false;
	}).catch(() => { _pingsEmAndamento = false; });
}

// ---------- visão para o painel ----------

let _sincronizado = false;
async function obterEstado() {
	const novos = importarDaPastaDownloads();
	if (novos.length && !estado.mensagem.startsWith('Servidores importados')) {
		definir({ mensagem: 'Servidores importados da pasta Downloads: ' + novos.map((s) => s.nome).join(', ') + '.' });
	}
	// Na primeira consulta descobre se o túnel já estava ligado (ex.: GoatCord reaberto)
	if (!_sincronizado && estado.fase === 'desligado') {
		_sincronizado = true;
		if (await tunelAtivo()) {
			definir({ fase: 'aguardando', mensagem: 'Túnel já estava ligado; conferindo…' });
			const execucao = ++_execucao;
			aguardarTrafego(execucao, 30000).then((ok) => {
				// O túnel está de pé de qualquer jeito; a sonda só informa o IP de saída
				if (execucao === _execucao) definir({ fase: 'conectado', mensagem: ok ? '' : 'Túnel ligado, mas não consegui medir o IP de saída.' });
			});
		}
	}
	const cfg = lerConfig();
	const servidores = listarServidores();
	if (Date.now() - _cachePingsTs > CACHE_PINGS_MS) iniciarPings(servidores);
	const servidoresComPing = servidores.map((s) => ({
		...s,
		ping: _cachePings.has(s.arquivo) ? _cachePings.get(s.arquivo) : null
	}));
	return {
		sucesso: true,
		suportado,
		motor: !!acharCli(),
		permissao: await tarefaMtuExiste(),
		...estado,
		servidores: servidoresComPing,
		selecionado: cfg.servidor,
		modo: cfg.modo,
		apps: cfg.apps,
		prefs: lerPrefs(),
		discord: { instalado: !!acharDiscord() }
	};
}

function salvarAjustes({ modo, apps, servidor }) {
	const cfg = lerConfig();
	if (modo === 'so' || modo === 'exceto') cfg.modo = modo;
	if (Array.isArray(apps)) cfg.apps = apps.filter((a) => typeof a === 'string' && a.length < 520 && /\.exe$/i.test(a));
	if (typeof servidor === 'string' && listarServidores().some((s) => s.arquivo === servidor)) cfg.servidor = servidor;
	salvarConfig(cfg);
	return cfg;
}

/** Botão "VPN só no Discord": deixa só o Discord marcado e conecta. */
async function ligarSoDiscord({ incluirGoatcord = false } = {}) {
	const discord = acharDiscord() || 'Discord.exe';
	const apps = [discord];
	if (incluirGoatcord && process.versions.electron) apps.push(process.execPath);
	salvarAjustes({ modo: 'so', apps });
	conectar();
	return { aberto: await discordAberto() };
}

// Ao abrir o GoatCord: liga sozinha, se a opção estiver marcada
async function aoIniciar() {
	if (!suportado || !lerPrefs().autoConectar || !acharCli()) return;
	_sincronizado = true;
	if (await tunelAtivo()) {
		const execucao = ++_execucao;
		definir({ fase: 'aguardando', mensagem: 'Túnel já estava ligado; conferindo…' });
		if (await aguardarTrafego(execucao, 30000)) definir({ fase: 'conectado', mensagem: '' });
		return;
	}
	conectar();
}

// Ao fechar o GoatCord (síncrono: o processo está saindo)
function aoFechar() {
	if (!suportado || !lerPrefs().desligarAoFechar) return;
	if (!['conectado', 'aguardando', 'conectando'].includes(estado.fase)) return;
	const c = acharCli();
	if (!c) return;
	try {
		require('child_process').execFileSync(c, ['disconnect'], { windowsHide: true, timeout: 10000 });
	} catch {}
}

module.exports = {
	suportado,
	obterEstado,
	listarApps,
	conectar,
	desconectar,
	reaplicarSeLigado,
	salvarAjustes,
	salvarPrefs,
	importarTexto,
	removerServidor,
	configurarPermissao,
	instalarMotor,
	ligarSoDiscord,
	discordAberto,
	reiniciarDiscord,
	aoIniciar,
	aoFechar,
	// para testes
	_internos: { montarPerfil, infoServidor, ehConfigWireGuard }
};
