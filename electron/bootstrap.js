'use strict';

// ===== Autoatualização pelo GitHub =====
// Ponto de entrada do app empacotado. A cada abertura pergunta ao GitHub qual o
// último commit da branch; se mudou, baixa o código (electron/, src/ etc.) para
// %APPDATA%\GoatCord\codigo e roda ESSA cópia. As dependências (node_modules) e o
// Electron continuam os do build: se o package.json do repo mudar dependências, a
// atualização não é aplicada e o app avisa que precisa de um build novo.
//
// Sem internet, sem token ou com qualquer erro, roda a última cópia baixada que
// funcionou, ou o código embutido no build. Este arquivo em si só muda com build novo.

const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFileSync } = require('child_process');
const { app, dialog } = require('electron');

// O main.js define isto, mas ele só carrega depois da checagem de rede e estas
// opções precisam valer ANTES do app ficar pronto. Repetir no main.js é inofensivo.
app.setName('GoatCord');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream', 'false');
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

const REPO = 'pkthegoat7/pkthegoat-clear';
const BRANCH = 'main';
const TEMPO_CHECAGEM_MS = 8000; // não segura a abertura mais que isso
const TEMPO_DOWNLOAD_MS = 60000;

// Só isto vem do repo; o resto (docs, testes, deploy) não é usado pelo app
const ITENS_DO_APP = ['electron/', 'src/', 'package.json'];

const DIR_EMBUTIDO = path.join(__dirname, '..'); // app.asar (ou a pasta do projeto em dev)
const DIR_BASE = path.join(app.getPath('appData'), 'GoatCord');
const DIR_CODIGO = path.join(DIR_BASE, 'codigo');
const ARQ_VERSAO = path.join(DIR_CODIGO, 'versao.json');
const ARQ_LOG = path.join(DIR_BASE, 'atualizacao.log');

function log(...partes) {
	const linha = `[${new Date().toISOString()}] ${partes.join(' ')}\n`;
	try {
		fs.mkdirSync(DIR_BASE, { recursive: true });
		// Mantém o log pequeno
		if (fs.existsSync(ARQ_LOG) && fs.statSync(ARQ_LOG).size > 200 * 1024) fs.writeFileSync(ARQ_LOG, '');
		fs.appendFileSync(ARQ_LOG, linha);
	} catch {}
	console.log('[update]', ...partes);
}

function lerJson(arquivo) {
	try {
		return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
	} catch {
		return null;
	}
}

// Repo privado: o token vem de GOATCORD_GH_TOKEN, de electron/update.local.json
// (gitignored) ou do GitHub CLI logado nesta máquina. Nada fica gravado no build.
function obterToken() {
	if (process.env.GOATCORD_GH_TOKEN) return process.env.GOATCORD_GH_TOKEN.trim();
	const local = lerJson(path.join(__dirname, 'update.local.json'));
	if (local && local.token) return String(local.token).trim();
	const candidatos = [
		path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
		path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe'),
		'gh'
	];
	for (const gh of candidatos) {
		if (gh !== 'gh' && !fs.existsSync(gh)) continue;
		try {
			const t = execFileSync(gh, ['auth', 'token'], { timeout: 4000, windowsHide: true, encoding: 'utf8' }).trim();
			if (t) return t;
		} catch {}
	}
	return null;
}

function requisicao(url, token, tempoMs, saidaArquivo) {
	return new Promise((resolve, reject) => {
		const headers = { 'User-Agent': 'GoatCord-Updater', Accept: 'application/vnd.github+json' };
		// O token só vai para a API do GitHub, nunca para o redirect do codeload
		if (token && new URL(url).hostname === 'api.github.com') headers.Authorization = `Bearer ${token}`;
		const req = https.get(url, { headers }, (res) => {
			if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
				res.resume();
				requisicao(res.headers.location, token, tempoMs, saidaArquivo).then(resolve, reject);
				return;
			}
			if (res.statusCode !== 200) {
				res.resume();
				reject(new Error(`HTTP ${res.statusCode} em ${new URL(url).pathname}`));
				return;
			}
			if (saidaArquivo) {
				const out = fs.createWriteStream(saidaArquivo);
				res.pipe(out);
				out.on('finish', () => out.close(() => resolve(saidaArquivo)));
				out.on('error', reject);
			} else {
				let dados = '';
				res.setEncoding('utf8');
				res.on('data', (c) => (dados += c));
				res.on('end', () => {
					try {
						resolve(JSON.parse(dados));
					} catch (e) {
						reject(e);
					}
				});
			}
			res.on('error', reject);
		});
		req.setTimeout(tempoMs, () => req.destroy(new Error('tempo esgotado')));
		req.on('error', reject);
	});
}

// Extrai só ITENS_DO_APP do zip do GitHub (que vem dentro de uma pasta "dono-repo-sha/")
function extrair(zip, destino) {
	const yauzl = require('yauzl');
	return new Promise((resolve, reject) => {
		yauzl.open(zip, { lazyEntries: true }, (err, arq) => {
			if (err) return reject(err);
			arq.on('error', reject);
			arq.on('end', resolve);
			arq.on('entry', (entrada) => {
				const relativo = entrada.fileName.split('/').slice(1).join('/');
				const quer = relativo && ITENS_DO_APP.some((i) => (i.endsWith('/') ? relativo.startsWith(i) : relativo === i));
				const alvo = path.resolve(destino, relativo);
				if (!quer || !alvo.startsWith(path.resolve(destino) + path.sep) || relativo.endsWith('/')) {
					arq.readEntry();
					return;
				}
				fs.mkdirSync(path.dirname(alvo), { recursive: true });
				arq.openReadStream(entrada, (e, leitura) => {
					if (e) return reject(e);
					const escrita = fs.createWriteStream(alvo);
					escrita.on('close', () => arq.readEntry());
					escrita.on('error', reject);
					leitura.pipe(escrita);
				});
			});
			arq.readEntry();
		});
	});
}

// node_modules e o Electron vêm do build: atualização que mexe nisso precisa de build novo
function dependenciasCompativeis(dirNovo) {
	const atual = lerJson(path.join(DIR_EMBUTIDO, 'package.json')) || {};
	const novo = lerJson(path.join(dirNovo, 'package.json')) || {};
	return JSON.stringify(atual.dependencies || {}) === JSON.stringify(novo.dependencies || {});
}

// Arquivos locais gitignored (OAuth, tracker) existem só no build; levamos junto para a cópia
function copiarArquivosLocais(dirNovo) {
	const dirEletron = path.join(DIR_EMBUTIDO, 'electron');
	try {
		for (const nome of fs.readdirSync(dirEletron)) {
			if (/\.local\.json$/.test(nome)) {
				fs.copyFileSync(path.join(dirEletron, nome), path.join(dirNovo, 'electron', nome));
			}
		}
	} catch {}
}

function rmrf(p) {
	try {
		fs.rmSync(p, { recursive: true, force: true });
	} catch {}
}

async function atualizar() {
	const token = obterToken();
	const atual = lerJson(ARQ_VERSAO);

	const commit = await requisicao(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, token, TEMPO_CHECAGEM_MS);
	const sha = commit && commit.sha;
	if (!sha) throw new Error('resposta sem sha');
	if (atual && atual.sha === sha && fs.existsSync(path.join(DIR_CODIGO, 'electron', 'main.js'))) {
		log('já na última versão', sha.slice(0, 7));
		return;
	}
	const ignorado = lerJson(path.join(DIR_BASE, 'atualizacao-pendente.json'));
	if (ignorado && ignorado.sha === sha) {
		log('versão', sha.slice(0, 7), 'precisa de build novo; continua na atual');
		return;
	}

	log('baixando', sha.slice(0, 7), '-', String(commit.commit && commit.commit.message).split('\n')[0]);
	const tmpZip = path.join(DIR_BASE, 'atualizacao.zip');
	const tmpDir = path.join(DIR_BASE, 'codigo.novo');
	rmrf(tmpDir);
	fs.mkdirSync(DIR_BASE, { recursive: true });
	try {
		await requisicao(`https://api.github.com/repos/${REPO}/zipball/${sha}`, token, TEMPO_DOWNLOAD_MS, tmpZip);
		await extrair(tmpZip, tmpDir);
	} finally {
		rmrf(tmpZip);
	}
	if (!fs.existsSync(path.join(tmpDir, 'electron', 'main.js'))) {
		rmrf(tmpDir);
		throw new Error('zip sem electron/main.js');
	}
	if (!dependenciasCompativeis(tmpDir)) {
		rmrf(tmpDir);
		fs.writeFileSync(path.join(DIR_BASE, 'atualizacao-pendente.json'), JSON.stringify({ sha }));
		log('versão', sha.slice(0, 7), 'mudou dependências: precisa de build novo');
		app.whenReady().then(() =>
			dialog.showMessageBox({
				type: 'info',
				title: 'GoatCord',
				message: 'Há uma atualização que precisa de um build novo do app.',
				detail: 'Ela mudou as dependências do package.json, então não dá para aplicar sozinha. O app continua na versão atual.'
			})
		);
		return;
	}
	copiarArquivosLocais(tmpDir);
	fs.writeFileSync(path.join(tmpDir, 'versao.json'), JSON.stringify({ sha, em: new Date().toISOString() }));

	// Troca a pasta inteira de uma vez (nada da cópia antiga está carregado ainda)
	const velho = path.join(DIR_BASE, 'codigo.velho');
	rmrf(velho);
	if (fs.existsSync(DIR_CODIGO)) fs.renameSync(DIR_CODIGO, velho);
	fs.renameSync(tmpDir, DIR_CODIGO);
	rmrf(velho);
	log('atualizado para', sha.slice(0, 7));
}

function carregar(dir) {
	// Código fora do asar procura node_modules subindo pastas e não acharia os do build
	process.env.NODE_PATH = [path.join(DIR_EMBUTIDO, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
	require('module')._initPaths();
	require(path.join(dir, 'electron', 'main.js'));
}

async function iniciar() {
	// Em desenvolvimento (npm run app) roda o código da pasta, sem baixar nada
	if (!app.isPackaged || process.env.GOATCORD_SEM_UPDATE === '1') {
		require('./main');
		return;
	}
	// A segunda instância só repassa o foco (o main.js cuida disso); não baixa nada
	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return;
	}

	try {
		await atualizar();
	} catch (e) {
		log('sem atualização:', (e && e.message) || e);
	}

	const versao = lerJson(ARQ_VERSAO);
	if (versao && fs.existsSync(path.join(DIR_CODIGO, 'electron', 'main.js'))) {
		try {
			log('rodando', versao.sha.slice(0, 7));
			carregar(DIR_CODIGO);
			return;
		} catch (e) {
			// Código baixado quebrado: descarta e volta para o embutido
			log('código baixado falhou, usando o embutido:', (e && e.stack) || e);
			rmrf(DIR_CODIGO);
		}
	}
	log('rodando o código embutido');
	require('./main');
}

iniciar();
