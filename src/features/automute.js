const { exibirTitulo } = require('../ui/titulo');
const { exibirErro } = require('../ui/menu');
const { readlineAsync } = require('../utils/readline-async');
const { sleep } = require('../utils/sleep');
const { atualizarPresenca } = require('../services/rpc');
const { automuteManager } = require('../services/automute');
const { backgroundTaskManager } = require('../utils/backgroundTasks');
const UIComponents = require('../utils/components');
const CONSTANTS = require('../config/constants');

const tasksPorUsuario = new Map();

function registrarTask(userId, tag) {
    if (tasksPorUsuario.has(userId)) return;

    const parar = async () => {
        automuteManager.remover(userId);
        tasksPorUsuario.delete(userId);
    };

    const taskId = backgroundTaskManager.addTask(
        `Automute: ${tag}`,
        parar,
        { usuario: tag, userId }
    );

    tasksPorUsuario.set(userId, taskId);
}

async function removerTask(userId) {
    const taskId = tasksPorUsuario.get(userId);
    if (taskId) {
        await backgroundTaskManager.removeTask(taskId);
        tasksPorUsuario.delete(userId);
    }
}

async function adicionarUsuario(client, corPrincipal) {
    UIComponents.limparTela();
    UIComponents.definirTituloJanela('GoatCord | Automute - Adicionar');
    exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

    UIComponents.exibirCabecalho('          ADICIONAR USUÁRIO AO AUTOMUTE', corPrincipal);
    UIComponents.exibirLinhaVazia();
    UIComponents.exibirInfo('Digite o ID do usuário:', corPrincipal);
    UIComponents.exibirLinhaVazia();

    const userId = (await readlineAsync.question(UIComponents.obterPrompt())).trim();
    if (!userId) return;

    UIComponents.exibirLinhaVazia();
    UIComponents.exibirInfo('Mutar também o ouvido (ensurdecer)? [s/N]:', corPrincipal);
    const respDeaf = (await readlineAsync.question(UIComponents.obterPrompt())).trim().toLowerCase();
    const deafen = respDeaf === 's' || respDeaf === 'sim' || respDeaf === 'y';

    automuteManager.setClient(client);
    const resultado = await automuteManager.adicionar(userId, deafen);

    UIComponents.limparTela();
    UIComponents.exibirSeparador(corPrincipal);

    if (resultado.sucesso) {
        registrarTask(userId, resultado.tag);
        UIComponents.exibirSucesso(
            `Automute ativo para: ${resultado.tag}${deafen ? ' (mic + ouvido)' : ''}`,
            corPrincipal
        );

        await atualizarPresenca({
            detalhe: `Automute: ${resultado.tag}`,
            estado: 'Vigiando entrada em call'
        }).catch(() => {});
    } else if (resultado.motivo === 'ja_existe') {
        UIComponents.exibirAviso(`Esse usuário já está no automute: ${resultado.tag}`, corPrincipal);
    } else if (resultado.motivo === 'usuario_invalido') {
        UIComponents.exibirErroMensagem('ID inválido ou usuário não encontrado.', corPrincipal);
    } else {
        UIComponents.exibirErroMensagem('Não foi possível adicionar.', corPrincipal);
    }

    UIComponents.exibirSeparador(corPrincipal);
    UIComponents.exibirLinhaVazia();
    await sleep(CONSTANTS.DELAYS.MESSAGE_DISPLAY);
}

async function removerUsuario(client, corPrincipal) {
    const lista = automuteManager.listar();

    UIComponents.limparTela();
    UIComponents.definirTituloJanela('GoatCord | Automute - Remover');
    exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

    UIComponents.exibirCabecalho('          REMOVER USUÁRIO DO AUTOMUTE', corPrincipal);
    UIComponents.exibirLinhaVazia();

    if (lista.length === 0) {
        UIComponents.exibirInfo('Nenhum usuário no automute.', corPrincipal);
        UIComponents.exibirLinhaVazia();
        await sleep(CONSTANTS.DELAYS.MESSAGE_DISPLAY);
        return;
    }

    lista.forEach((u, i) => {
        UIComponents.exibirOpcaoMenu(String(i + 1), `${u.tag} (${u.userId})`, corPrincipal);
    });
    UIComponents.exibirLinhaVazia();
    UIComponents.exibirInfo('Digite o número (ou 0 para voltar):', corPrincipal);
    UIComponents.exibirLinhaVazia();

    const entrada = (await readlineAsync.question(UIComponents.obterPrompt())).trim();
    const indice = parseInt(entrada, 10) - 1;

    if (entrada === '0' || isNaN(indice)) return;
    if (indice < 0 || indice >= lista.length) {
        await exibirErro('Opção inválida.', 1.5);
        return;
    }

    const alvo = lista[indice];
    const resultado = automuteManager.remover(alvo.userId);
    if (resultado.sucesso) {
        await removerTask(alvo.userId);

        UIComponents.limparTela();
        UIComponents.exibirSeparador(corPrincipal);
        UIComponents.exibirSucesso(`Removido: ${resultado.tag}`, corPrincipal);
        UIComponents.exibirSeparador(corPrincipal);
        UIComponents.exibirLinhaVazia();

        await atualizarPresenca({
            detalhe: 'No menu principal'
        }).catch(() => {});

        await sleep(CONSTANTS.DELAYS.MESSAGE_DISPLAY);
    }
}

async function limparTodos(client, corPrincipal) {
    UIComponents.limparTela();
    UIComponents.definirTituloJanela('GoatCord | Automute - Limpar');
    exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

    UIComponents.exibirCabecalho('          LIMPAR LISTA DE AUTOMUTE', corPrincipal);
    UIComponents.exibirLinhaVazia();
    UIComponents.exibirAviso('Remover TODOS os usuários do automute?', corPrincipal);
    UIComponents.exibirLinhaVazia();
    UIComponents.exibirOpcaoMenu('1', 'Sim', corPrincipal);
    UIComponents.exibirOpcaoMenu('2', 'Não', corPrincipal);
    UIComponents.exibirLinhaVazia();

    const confirma = (await readlineAsync.question(UIComponents.obterPrompt())).trim();
    if (confirma !== '1') return;

    for (const userId of Array.from(tasksPorUsuario.keys())) {
        await removerTask(userId);
    }
    const total = automuteManager.limpar();

    UIComponents.limparTela();
    UIComponents.exibirSeparador(corPrincipal);
    UIComponents.exibirSucesso(`${total} usuário(s) removido(s) do automute.`, corPrincipal);
    UIComponents.exibirSeparador(corPrincipal);
    UIComponents.exibirLinhaVazia();
    await sleep(CONSTANTS.DELAYS.MESSAGE_DISPLAY);
}

async function menuAutomute(client, corPrincipal) {
    if (!client?.user) {
        await exibirErro('Cliente Discord não está conectado.');
        return;
    }

    automuteManager.setClient(client);

    while (true) {
        const lista = automuteManager.listar();

        UIComponents.limparTela();
        UIComponents.definirTituloJanela('GoatCord | Automute');
        exibirTitulo(client.user.username, client.user.id, corPrincipal);

        UIComponents.exibirCabecalho('          AUTOMUTE - MUTAR USUÁRIO AUTOMATICAMENTE', corPrincipal);
        UIComponents.exibirLinhaVazia();
        UIComponents.exibirInfo(
            'Sempre que um usuário da lista entrar em call, o mic dele é mutado.',
            corPrincipal
        );
        UIComponents.exibirLinhaVazia();

        if (lista.length === 0) {
            UIComponents.exibirInfo('Nenhum usuário no automute.', corPrincipal);
        } else {
            UIComponents.exibirInfo(`Usuários ativos (${lista.length}):`, corPrincipal);
            lista.forEach((u, i) => {
                console.log(`        ${i + 1}. ${u.tag}  (${u.userId})${u.deafen ? '  [mic + ouvido]' : ''}`);
            });
        }

        UIComponents.exibirLinhaVazia();
        UIComponents.exibirOpcaoMenu('1', 'Adicionar usuário', corPrincipal);
        UIComponents.exibirOpcaoMenu('2', 'Remover usuário', corPrincipal);
        UIComponents.exibirOpcaoMenu('3', 'Limpar lista', corPrincipal);
        UIComponents.exibirOpcaoMenu('0', 'Voltar', corPrincipal);
        UIComponents.exibirLinhaVazia();

        const opcao = (await readlineAsync.question(UIComponents.obterPrompt())).trim();

        switch (opcao) {
            case '1':
                await adicionarUsuario(client, corPrincipal);
                break;
            case '2':
                await removerUsuario(client, corPrincipal);
                break;
            case '3':
                await limparTodos(client, corPrincipal);
                break;
            case '0':
                return;
            default:
                await exibirErro('Opção inválida.', 1.5);
        }
    }
}

module.exports = { menuAutomute };
