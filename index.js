#!/usr/bin/env node

// Carrega o .env em execução local (Node >=20.12). No Railway/Render as variáveis
// já vêm injetadas pela plataforma e não há .env — por isso o try/catch silencioso.
try { process.loadEnvFile(); } catch {}

const { criarConfig, sincronizarVersaoRPC, obterConfig } = require('./src/config/configuracao');
const { iniciarServidorWebUI, abrirNoNavegador } = require('./src/services/web-ui-server');
const { reconectarSessoesSalvas } = require('./src/services/user-context');
const { inicializarRPC } = require('./src/services/rpc');
const UIComponents = require('./src/utils/components');
const { Cores, Simbolos } = require('./src/utils/cores');
const { version: VERSAO_ATUAL } = require('./package.json');

async function inicializar() {
	UIComponents.limparTela();
	UIComponents.definirTituloJanela(`GoatCord v${VERSAO_ATUAL} | Painel Web`);

	criarConfig();
	sincronizarVersaoRPC();
	const config = obterConfig();
	const corPrincipal = Cores.principal(config.cor_painel);

	inicializarRPC().catch(() => {});

	const { porta, url } = await iniciarServidorWebUI();

	UIComponents.exibirCabecalho(`          GoatCord v${VERSAO_ATUAL}`, corPrincipal);
	UIComponents.exibirLinhaVazia();
	UIComponents.exibirSucesso(`Painel rodando em ${url}`, corPrincipal);
	UIComponents.exibirInfo('Abrindo no navegador...', corPrincipal);
	UIComponents.exibirLinhaVazia();
	UIComponents.exibirSeparador(corPrincipal);
	UIComponents.exibirInfo('Gerencie tokens e conecte direto pelo painel web.', corPrincipal);
	UIComponents.exibirInfo('Esta janela só mantém o servidor vivo.', corPrincipal);
	UIComponents.exibirInfo('Comandos com prefixo `;` no Discord continuam funcionando após login.', corPrincipal);
	UIComponents.exibirSeparador(corPrincipal);
	UIComponents.exibirLinhaVazia();
	UIComponents.exibirInfo('Pressione Ctrl+C para encerrar.', corPrincipal);

	// Reconecta sozinho os selfs que estavam ativos antes de um restart do
	// processo (ex.: Railway reiniciando o container). Não bloqueia o boot.
	reconectarSessoesSalvas()
		.then((r) => {
			if (r && r.reconectados) {
				UIComponents.exibirSucesso(`Selfs reconectados automaticamente: ${r.reconectados}/${r.total}`, corPrincipal);
			}
		})
		.catch(() => {});

	abrirNoNavegador(url);
}

inicializar().catch((erro) => {
	console.error(`${Simbolos.erro} Erro fatal:`, erro);
	process.exit(1);
});
