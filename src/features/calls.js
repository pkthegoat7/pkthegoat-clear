const { Cores, Simbolos, textoRainbow } = require('../utils/cores');
const { sleep } = require('../utils/sleep');
const { exibirTitulo } = require('../ui/titulo');
const { solicitarTexto, exibirErro } = require('../ui/menu');
const { atualizarPresenca } = require('../services/rpc');
const { readlineAsync } = require('../utils/readline-async');
const UIComponents = require('../utils/components');
const CONSTANTS = require('../config/constants');
const { backgroundTaskManager } = require('../utils/backgroundTasks');

/**
 * Menu principal de utilidades de call
 * @param {Client} client - Cliente do Discord
 * @param {string} corPrincipal - Cor principal do menu
 */
async function utilidadesCall(client, corPrincipal) {
	UIComponents.limparTela();
	UIComponents.definirTituloJanela('pkthegoat clear | Utilidades de call');

	exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

	UIComponents.exibirCabecalho('          UTILIDADES DE CALL', corPrincipal);
	UIComponents.exibirLinhaVazia();
	UIComponents.exibirOpcaoMenu('1', 'Desconectar todos da call', corPrincipal);
	UIComponents.exibirOpcaoMenu('2', 'Mover membros entre calls', corPrincipal);
	UIComponents.exibirOpcaoMenu('3', 'Farmar horas em call', corPrincipal);
	UIComponents.exibirOpcaoMenu('4', 'Mutar/Desmutar todos na call', corPrincipal);
	UIComponents.exibirOpcaoMenu('5', 'Ensurdecer/Desensurdecer todos na call', corPrincipal);
	UIComponents.exibirOpcaoMenu('6', 'Listar membros da call', corPrincipal);
	UIComponents.exibirOpcaoMenu('7', 'Elevador (mover user entre calls)', corPrincipal);
	UIComponents.exibirOpcaoMenu('8', 'Coleira (manter user na mesma call)', corPrincipal);
	UIComponents.exibirOpcaoMenu('9', 'Proteger usuário (anti mute/deaf)', corPrincipal);
	UIComponents.exibirOpcaoMenu('0', 'Voltar', corPrincipal);
	UIComponents.exibirLinhaVazia();
	const opcao = await readlineAsync.question(UIComponents.obterPrompt());

	const voltarMenu = async () => {
		await sleep(CONSTANTS.DELAYS.SHORT_PAUSE);
		return;
	};

	const obterCanalVoz = (id) => {
		const canal = client.channels.cache.get(id);
		return canal?.type === 'GUILD_VOICE' ? canal : null;
	};
	const desconectarTodos = async () => {
		UIComponents.limparTela();
		UIComponents.definirTituloJanela('pkthegoat clear | Desconectar todos');

		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho('          DESCONECTAR TODOS DA CALL', corPrincipal);
		UIComponents.exibirLinhaVazia();
		UIComponents.exibirInfo('Digite o ID da call:', corPrincipal);
		UIComponents.exibirLinhaVazia();

		const idCall = await readlineAsync.question(UIComponents.obterPrompt());

		UIComponents.limparTela();
		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho('          CONFIRMAR AÇÃO', corPrincipal);
		UIComponents.exibirLinhaVazia();
		UIComponents.exibirAviso('Tem certeza que deseja desconectar todos?', corPrincipal);
		UIComponents.exibirLinhaVazia();

		UIComponents.exibirOpcaoMenu('1', 'Sim', corPrincipal);
		UIComponents.exibirOpcaoMenu('2', 'Não', corPrincipal);
		UIComponents.exibirLinhaVazia();

		const confirma = await readlineAsync.question(UIComponents.obterPrompt());
		if (confirma !== '1') {
			return voltarMenu();
		}

		const canal = obterCanalVoz(idCall);

		if (!canal) {
			await exibirErro('ID inválido.');
			return voltarMenu();
		}

		if (!canal.members.size) {
			await exibirErro('A call está vazia.');
			return voltarMenu();
		}

		UIComponents.limparTela();
		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho('          DESCONECTANDO MEMBROS', corPrincipal);
		UIComponents.exibirLinhaVazia();

		let desconectados = 0;
		for (const member of canal.members.values()) {
			try {
				await member.voice.setChannel(null);
				desconectados++;

				console.log(
					`        ${Simbolos.sucesso} ${UIComponents.textoColorido(member.user.tag, corPrincipal, false)} desconectado`
				);
			} catch (err) {
				if (err.message === 'Missing Permissions') {
					await exibirErro('Você não tem permissão para desconectar membros.');
					return voltarMenu();
				}
			}
		}

		UIComponents.exibirLinhaVazia();
		UIComponents.exibirSeparador(corPrincipal);
		UIComponents.exibirSucesso(`${desconectados} membro(s) desconectado(s)!`, corPrincipal);
		UIComponents.exibirSeparador(corPrincipal);
		UIComponents.exibirLinhaVazia();

		await sleep(CONSTANTS.DELAYS.LONG_PAUSE);
		await voltarMenu();
	};

	const moverMembros = async () => {
		UIComponents.limparTela();
		UIComponents.definirTituloJanela('pkthegoat clear | Mover membros');

		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho('          MOVER MEMBROS ENTRE CALLS', corPrincipal);
		UIComponents.exibirLinhaVazia();
		UIComponents.exibirInfo('Digite o ID da call de origem:', corPrincipal);
		UIComponents.exibirLinhaVazia();
		const idOrigem = await readlineAsync.question(UIComponents.obterPrompt());

		UIComponents.limparTela();
		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho('          MOVER MEMBROS ENTRE CALLS', corPrincipal);
		UIComponents.exibirLinhaVazia();
		UIComponents.exibirInfo('Digite o ID da call de destino:', corPrincipal);
		UIComponents.exibirLinhaVazia();

		const idDestino = await readlineAsync.question(UIComponents.obterPrompt());

		UIComponents.limparTela();
		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho('          CONFIRMAR AÇÃO', corPrincipal);
		UIComponents.exibirLinhaVazia();
		UIComponents.exibirAviso('Tem certeza que deseja mover os usuários?', corPrincipal);
		UIComponents.exibirLinhaVazia();

		UIComponents.exibirOpcaoMenu('1', 'Sim', corPrincipal);
		UIComponents.exibirOpcaoMenu('2', 'Não', corPrincipal);
		UIComponents.exibirLinhaVazia();

		const confirma = await readlineAsync.question(UIComponents.obterPrompt());
		if (confirma !== '1') {
			return voltarMenu();
		}

		const canalOrigem = obterCanalVoz(idOrigem);
		const canalDestino = obterCanalVoz(idDestino);

		if (!canalOrigem || !canalDestino) {
			await exibirErro('ID inválido.');
			return voltarMenu();
		}

		if (!canalOrigem.members.size) {
			await exibirErro('A call de origem está vazia.');
			return voltarMenu();
		}

		UIComponents.limparTela();
		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho('          MOVENDO MEMBROS', corPrincipal);
		UIComponents.exibirLinhaVazia();

		let movidos = 0;
		for (const member of canalOrigem.members.values()) {
			if (canalDestino.locked || canalDestino.full) {
				await exibirErro('A call de destino está privada ou lotada.');
				return voltarMenu();
			}

			try {
				await member.voice.setChannel(canalDestino.id);
				if (member.id !== client.user.id) {
					movidos++;
					console.log(
						`        ${Simbolos.sucesso} ${UIComponents.textoColorido(member.user.username, corPrincipal, false)} ${UIComponents.textoColorido(canalDestino.name, corPrincipal, false)}`
					);
				}
			} catch (err) {
				if (err.message === 'Missing Permissions') {
					await exibirErro('Você não tem permissão para mover membros.');
					return voltarMenu();
				}
			}
		}

		UIComponents.exibirLinhaVazia();
		UIComponents.exibirSeparador(corPrincipal);
		UIComponents.exibirSucesso(`${movidos} membro(s) movido(s) com sucesso!`, corPrincipal);
		UIComponents.exibirSeparador(corPrincipal);
		UIComponents.exibirLinhaVazia();

		await sleep(CONSTANTS.DELAYS.LONG_PAUSE);
		await voltarMenu();
	};

	const mutarDesmutarTodos = async () => {
		UIComponents.limparTela();
		UIComponents.definirTituloJanela('pkthegoat clear | Mutar/Desmutar Todos');

		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho('          MUTAR/DESMUTAR TODOS NA CALL', corPrincipal);
		UIComponents.exibirLinhaVazia();

		UIComponents.exibirOpcaoMenu('1', 'Mutar todos', corPrincipal);
		UIComponents.exibirOpcaoMenu('2', 'Desmutar todos', corPrincipal);
		UIComponents.exibirLinhaVazia();

		const escolha = await readlineAsync.question(UIComponents.obterPrompt());

		if (!['1', '2'].includes(escolha)) {
			await exibirErro('Op��o inv�lida.');
			return await voltarMenu();
		}

		const deMutar = escolha === '1';

		UIComponents.limparTela();
		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho(`          ${deMutar ? 'MUTAR TODOS' : 'DESMUTAR TODOS'} NA CALL`, corPrincipal);
		UIComponents.exibirLinhaVazia();
		UIComponents.exibirInfo('Digite o ID da call:', corPrincipal);
		UIComponents.exibirLinhaVazia();

		const idCall = await readlineAsync.question(UIComponents.obterPrompt());
		const canal = client.channels.cache.get(idCall);

		if (!canal || canal.type !== 'GUILD_VOICE') {
			await exibirErro('ID inválido.');
			return voltarMenu();
		}

		if (!canal.members.size) {
			await exibirErro('A call está vazia.');
			return voltarMenu();
		}

		UIComponents.limparTela();
		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho(`          ${deMutar ? 'MUTANDO TODOS' : 'DESMUTANDO TODOS'}`, corPrincipal);
		UIComponents.exibirLinhaVazia();

		let afetados = 0;
		for (const member of canal.members.values()) {
			try {
				await member.voice.setMute(deMutar);
				afetados++;

				console.log(
					`        ${Simbolos.sucesso} ${UIComponents.textoColorido(member.user.tag, corPrincipal, false)} ${deMutar ? 'mutado' : 'desmutado'}`
				);
			} catch (err) {
				if (err.message === 'Missing Permissions') {
					await exibirErro('Você não tem permissão para mutar/desmutar membros.');
					return voltarMenu();
				}
			}
		}

		UIComponents.exibirLinhaVazia();
		UIComponents.exibirSeparador(corPrincipal);
		UIComponents.exibirSucesso(
			`${afetados} membro(s) ${deMutar ? 'mutado(s)' : 'desmutado(s)'} com sucesso!`,
			corPrincipal
		);
		UIComponents.exibirSeparador(corPrincipal);
		UIComponents.exibirLinhaVazia();

		await sleep(CONSTANTS.DELAYS.LONG_PAUSE);
		await voltarMenu();
	};

	const ensurdecerDesensurdecerTodos = async () => {
		UIComponents.limparTela();
		UIComponents.definirTituloJanela('pkthegoat clear | Ensurdecer/Desensurdecer Todos');

		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho('          ENSURDECER/DESENSURDECER TODOS NA CALL', corPrincipal);
		UIComponents.exibirLinhaVazia();

		UIComponents.exibirOpcaoMenu('1', 'Ensurdecer todos', corPrincipal);
		UIComponents.exibirOpcaoMenu('2', 'Desensurdecer todos', corPrincipal);
		UIComponents.exibirLinhaVazia();

		const escolha = await readlineAsync.question(UIComponents.obterPrompt());

		if (!['1', '2'].includes(escolha)) {
			await exibirErro('Op��o inv�lida.');
			return await voltarMenu();
		}

		const ensurdecer = escolha === '1';

		UIComponents.limparTela();
		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho(
			`          ${ensurdecer ? 'ENSURDECER TODOS' : 'DESENSURDECER TODOS'} NA CALL`,
			corPrincipal
		);
		UIComponents.exibirLinhaVazia();
		UIComponents.exibirInfo('Digite o ID da call:', corPrincipal);
		UIComponents.exibirLinhaVazia();

		const idCall = await readlineAsync.question(UIComponents.obterPrompt());
		const canal = client.channels.cache.get(idCall);

		if (!canal || canal.type !== 'GUILD_VOICE') {
			await exibirErro('ID inválido.');
			return voltarMenu();
		}

		if (!canal.members.size) {
			await exibirErro('A call está vazia.');
			return voltarMenu();
		}

		UIComponents.limparTela();
		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho(
			`          ${ensurdecer ? 'ENSURDECENDO TODOS' : 'DESENSURDECENDO TODOS'}`,
			corPrincipal
		);
		UIComponents.exibirLinhaVazia();

		let afetados = 0;
		for (const member of canal.members.values()) {
			try {
				await member.voice.setDeaf(ensurdecer);
				afetados++;

				console.log(
					`        ${Simbolos.sucesso} ${UIComponents.textoColorido(member.user.tag, corPrincipal, false)} ${ensurdecer ? 'ensurdecido' : 'desensurdecido'}`
				);
			} catch (err) {
				if (err.message === 'Missing Permissions') {
					await exibirErro('Você não tem permissão para ensurdecer/desensurdecer membros.');
					return voltarMenu();
				}
			}
		}

		UIComponents.exibirLinhaVazia();
		UIComponents.exibirSeparador(corPrincipal);
		UIComponents.exibirSucesso(
			`${afetados} membro(s) ${ensurdecer ? 'ensurdecido(s)' : 'desensurdecido(s)'} com sucesso!`,
			corPrincipal
		);
		UIComponents.exibirSeparador(corPrincipal);
		UIComponents.exibirLinhaVazia();

		await sleep(CONSTANTS.DELAYS.LONG_PAUSE);
		await voltarMenu();
	};

	const listarMembros = async () => {
		UIComponents.limparTela();
		UIComponents.definirTituloJanela('pkthegoat clear | Listar membros');

		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho('          LISTAR MEMBROS DA CALL', corPrincipal);
		UIComponents.exibirLinhaVazia();
		UIComponents.exibirInfo('Digite o ID da call:', corPrincipal);
		UIComponents.exibirLinhaVazia();

		const idCall = await readlineAsync.question(UIComponents.obterPrompt());
		const canal = client.channels.cache.get(idCall);

		if (!canal || canal.type !== 'GUILD_VOICE') {
			await exibirErro('ID inválido.');
			return voltarMenu();
		}

		UIComponents.limparTela();
		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho('          MEMBROS DA CALL', corPrincipal);
		UIComponents.exibirLinhaVazia();

		console.log(`        ${Simbolos.info} Canal: ${UIComponents.textoColorido(canal.name, corPrincipal, false)}`);
		console.log(
			`        ${Simbolos.info} Total: ${UIComponents.textoColorido(`${canal.members.size} membro(s)`, corPrincipal, false)}`
		);
		UIComponents.exibirLinhaVazia();

		if (canal.members.size === 0) {
			UIComponents.exibirAviso('A call está vazia.', corPrincipal);
			UIComponents.exibirLinhaVazia();
		} else {
			let contador = 1;
			for (const member of canal.members.values()) {
				const statusMute = member.voice.mute ? '[mudo]' : '';
				const statusDeaf = member.voice.deaf ? '[surdo]' : '';
				const statusVideo = member.voice.streaming ? '[live]' : member.voice.selfVideo ? '[cam]' : '';

				console.log(
					`        ${UIComponents.textoColorido(`${contador}.`, corPrincipal, false)} ${UIComponents.textoColorido(member.user.tag, corPrincipal, false)} ${statusMute} ${statusDeaf} ${statusVideo}`
				);
				console.log(`           ${Simbolos.info} ID: ${UIComponents.textoColorido(member.id, corPrincipal, false)}`);
				contador++;
			}
			UIComponents.exibirLinhaVazia();
		}

		UIComponents.exibirSeparador(corPrincipal);
		UIComponents.exibirLinhaVazia();

		console.log(`        Pressione ENTER para voltar ao menu...`);
		await readlineAsync.question(UIComponents.obterPrompt());

		await voltarMenu();
	};

	const farmarHoras = async () => {
		UIComponents.limparTela();
		UIComponents.definirTituloJanela('pkthegoat clear | Farmar horas');

		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho('          FARMAR HORAS EM CALL', corPrincipal);
		UIComponents.exibirLinhaVazia();
		UIComponents.exibirOpcaoMenu('1', 'Farmar em call específica', corPrincipal);
		UIComponents.exibirOpcaoMenu('2', 'Farmar em calls aleatórias', corPrincipal);
		UIComponents.exibirLinhaVazia();

		const escolha = await readlineAsync.question(UIComponents.obterPrompt());
		if (!['1', '2'].includes(escolha)) {
			await exibirErro('Op��o inv�lida.');
			return await voltarMenu();
		}

		UIComponents.limparTela();
		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);
		UIComponents.exibirCabecalho('          MODO DE EXECUÇÃO', corPrincipal);
		UIComponents.exibirLinhaVazia();
		UIComponents.exibirOpcaoMenu('1', 'Executar em primeiro plano (bloqueante)', corPrincipal);
		UIComponents.exibirOpcaoMenu('2', 'Executar em segundo plano (retorna ao menu)', corPrincipal);
		UIComponents.exibirLinhaVazia();

		const modoExecucao = await readlineAsync.question(UIComponents.obterPrompt());
		const emSegundoPlano = modoExecucao === '2';

		let canalSelecionado;

		if (escolha === '1') {
			UIComponents.limparTela();
			exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

			UIComponents.exibirCabecalho('          FARMAR EM CALL ESPECÍFICA', corPrincipal);
			UIComponents.exibirLinhaVazia();
			UIComponents.exibirInfo('Digite o ID da call:', corPrincipal);
			UIComponents.exibirLinhaVazia();
			const idCall = await readlineAsync.question(UIComponents.obterPrompt());
			const canal = client.channels.cache.get(idCall);

			if (!canal || canal.type !== 'GUILD_VOICE') {
				await exibirErro('ID inválido.');
				return await voltarMenu();
			}

			if (!canal.permissionsFor(canal.guild.members.me).has('CONNECT')) {
				await exibirErro('Sem permissão para entrar na call.');
				return await voltarMenu();
			}
			canalSelecionado = canal;
		} else {
			UIComponents.limparTela();
			exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

			UIComponents.exibirCabecalho('          FARMAR EM CALLS ALEATÓRIAS', corPrincipal);
			UIComponents.exibirLinhaVazia();
			UIComponents.exibirInfo('Digite o ID do servidor:', corPrincipal);
			UIComponents.exibirLinhaVazia();
			const idGuild = await readlineAsync.question(UIComponents.obterPrompt());
			const guild = client.guilds.cache.get(idGuild);
			if (!guild) {
				await exibirErro('Servidor não encontrado.');
				return await voltarMenu();
			}

			UIComponents.limparTela();
			exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

			UIComponents.exibirCabecalho('          CATEGORIA (OPCIONAL)', corPrincipal);
			UIComponents.exibirLinhaVazia();

			console.log(`        ${Simbolos.info} Digite o ID da categoria (opcional):`);
			console.log(`        ${Simbolos.info} Deixe vazio para buscar em qualquer categoria`);
			UIComponents.exibirLinhaVazia();
			const categoria = await readlineAsync.question(UIComponents.obterPrompt());

			const calls = guild.channels.cache.filter(
				(c) =>
					c.type === 'GUILD_VOICE' &&
					c.members.size === 0 &&
					c.permissionsFor(guild.members.me).has('CONNECT') &&
					(!categoria || c.parentId === categoria)
			);

			if (!calls.size) {
				await exibirErro('Nenhuma call vazia disponível.');
				return await voltarMenu();
			}

			canalSelecionado = calls.random();
		}
		let connection;
		let tempoAcumulado = 0;
		let iniciou = Date.now();
		let farmPausado = false;

		const conectar = async (tentativa = 1, maxTentativas = 3) => {
			try {
				connection = await client.voice.joinChannel(canalSelecionado, {
					selfMute: false,
					selfDeaf: false,
					selfVideo: false
				});

				return true;
			} catch (err) {
				if (tentativa < maxTentativas) {
					const esperaSegundos = tentativa * 2;
					await new Promise((resolve) => setTimeout(resolve, esperaSegundos * 1000));
					return await conectar(tentativa + 1, maxTentativas);
				}

				await exibirErro(`Erro ao conectar após ${maxTentativas} tentativas: ${err.message}`);
				return false;
			}
		};

		const sucesso = await conectar();
		if (!sucesso) {
			return await voltarMenu();
		}

		let deveContinuar = true;
		let atualizarTempo;
		let voiceUpdateListener;

		const pararFarmagem = async () => {
			deveContinuar = false;
			if (atualizarTempo) clearInterval(atualizarTempo);
			if (voiceUpdateListener) client.off('voiceStateUpdate', voiceUpdateListener);
			if (connection) {
				await connection.disconnect();
			}
			atualizarPresenca({
				detalhe: 'No menu principal'
			});
		};

		const tempoDecorrido = () => tempoAcumulado + (farmPausado ? 0 : Date.now() - iniciou);

		const exibirTelaTempo = () => {
			if (!deveContinuar) return;
			const tempo = tempoDecorrido();
			const segundos = Math.floor((tempo / 1000) % 60);
			const minutos = Math.floor((tempo / 1000 / 60) % 60);
			const horas = Math.floor(tempo / 1000 / 60 / 60);

			const nomeCanal = canalSelecionado?.name || 'Canal Desconhecido';
			const nomeGuild = canalSelecionado?.guild?.name || 'Servidor Desconhecido';
			const iconGuild = canalSelecionado?.guild?.iconURL({ dynamic: true, size: 256 }) ||
				'https://i.pinimg.com/736x/5c/d1/72/5cd172ee967ee3c703c3de27f1f240db.jpg';

			atualizarPresenca({
				estado: `${horas}h ${minutos}m ${segundos}s`,
				detalhe: farmPausado ? 'Farm pausado (em call)' : `Farmando em: ${nomeCanal}`,
				imagemPequena: iconGuild,
				textoImagemPequena: nomeGuild
			});

			if (!emSegundoPlano) {
				UIComponents.limparTela();
				exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

				UIComponents.exibirCabecalho(
					farmPausado ? '          FARM PAUSADO (VOCÊ ESTÁ EM CALL)' : '          FARMANDO HORAS',
					corPrincipal
				);
				UIComponents.exibirLinhaVazia();

				console.log(
					`        ${Simbolos.sucesso} Tempo: ${UIComponents.textoColorido(`${horas}h ${minutos}m ${segundos}s`, corPrincipal, false)}`
				);
				console.log(
					`        ${Simbolos.info} Call: ${UIComponents.textoColorido(nomeCanal, corPrincipal, false)}`
				);
				if (farmPausado) {
					UIComponents.exibirLinhaVazia();
					UIComponents.exibirAviso('Você entrou em uma call. O farm retoma quando você sair.', corPrincipal);
				}
				UIComponents.exibirLinhaVazia();
				console.log(
					`        Pressione ${UIComponents.textoColorido('QUALQUER TECLA', corPrincipal, false)} para parar e voltar ao menu.`
				);
				UIComponents.exibirLinhaVazia();
			}
		};

		exibirTelaTempo();

		atualizarTempo = setInterval(exibirTelaTempo, 1000);
		voiceUpdateListener = async (oldState, newState) => {
			if (newState.member.id !== client.user.id) return;
			if (!deveContinuar) return;

			if (!farmPausado) {
				// Você entrou/mudou para outra call (diferente do canal de farm) -> pausar farm
				if (newState.channelId && newState.channelId !== canalSelecionado.id) {
					farmPausado = true;
					tempoAcumulado += Date.now() - iniciou;
					// não desconectamos: você continua na call em que entrou
					connection = null;
					exibirTelaTempo();
					return;
				}

				// Você foi desconectado e não está em call nenhuma -> continuar farmando
				if (!newState.channelId) {
					await sleep(2);
					if (farmPausado || !deveContinuar) return;

					const reconectouComSucesso = await conectar();
					if (reconectouComSucesso) {
						iniciou = Date.now();
					} else {
						clearInterval(atualizarTempo);
						client.off('voiceStateUpdate', voiceUpdateListener);
					}
				}
			} else {
				// Farm pausado: você saiu da call (não está mais em nenhuma) -> retomar farm
				if (!newState.channelId) {
					await sleep(2);
					if (!deveContinuar) return;

					const reconectouComSucesso = await conectar();
					if (reconectouComSucesso) {
						farmPausado = false;
						iniciou = Date.now();
						exibirTelaTempo();
					}
				}
			}
		};

		client.on('voiceStateUpdate', voiceUpdateListener);

		if (emSegundoPlano) {
			const nomeCanal = canalSelecionado?.name || 'Canal Desconhecido';
			const nomeGuild = canalSelecionado?.guild?.name || 'Servidor Desconhecido';
			
			const taskId = backgroundTaskManager.addTask(
				`Farmar em: ${nomeCanal}`,
				pararFarmagem,
				{
					canal: nomeCanal,
					guild: nomeGuild,
					iniciou
				}
			);

			UIComponents.limparTela();
			exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);
			UIComponents.exibirCabecalho('          FARMAGEM EM SEGUNDO PLANO', corPrincipal);
			UIComponents.exibirLinhaVazia();
			UIComponents.exibirSucesso(`Farmagem iniciada em segundo plano!`, corPrincipal);
			UIComponents.exibirInfo(`Canal: ${nomeCanal}`, corPrincipal);
			UIComponents.exibirInfo(`Você pode gerenciar esta tarefa no menu principal`, corPrincipal);
			UIComponents.exibirLinhaVazia();
			await sleep(CONSTANTS.DELAYS.SHORT_PAUSE);

			return await voltarMenu();
		} else {
			await new Promise((resolve) => {
				const checkInterval = setInterval(() => {}, 100);

				const stdin = process.stdin;
				stdin.setRawMode(true);
				stdin.resume();
				stdin.setEncoding('utf8');
				const onData = () => {
					deveContinuar = false;
					clearInterval(atualizarTempo);
					clearInterval(checkInterval);
					stdin.setRawMode(false);
					stdin.pause();
					stdin.removeListener('data', onData);
					resolve();
				};

				stdin.on('data', onData);
			});
			
			await pararFarmagem();

			return await voltarMenu();
		}
	};
	const elevador = async () => {
		UIComponents.limparTela();
		UIComponents.definirTituloJanela('pkthegoat clear | Elevador');

		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho('          ELEVADOR', corPrincipal);
		UIComponents.exibirLinhaVazia();
		UIComponents.exibirInfo('Digite o ID da categoria:', corPrincipal);
		UIComponents.exibirLinhaVazia();

		const idCategoria = await readlineAsync.question(UIComponents.obterPrompt());

		UIComponents.limparTela();
		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho('          ELEVADOR', corPrincipal);
		UIComponents.exibirLinhaVazia();
		UIComponents.exibirInfo('Digite o ID do usuário:', corPrincipal);
		UIComponents.exibirLinhaVazia();
		const idUsuario = await readlineAsync.question(UIComponents.obterPrompt());

		const categoria = client.channels.cache.get(idCategoria);
		if (!categoria || categoria.type !== 'GUILD_CATEGORY') {
			await exibirErro('ID de categoria inválido.');
			return voltarMenu();
		}

		const canaisVoz = categoria.guild.channels.cache.filter(
			(c) => c.type === 'GUILD_VOICE' && c.parentId === idCategoria
		);

		if (canaisVoz.size === 0) {
			await exibirErro('Nenhum canal de voz encontrado nesta categoria.');
			return voltarMenu();
		}

		const membro = await categoria.guild.members.fetch(idUsuario).catch(() => null);
		if (!membro) {
			await exibirErro('Usuário não encontrado no servidor.');
			return voltarMenu();
		}

		if (!membro.voice.channelId) {
			await exibirErro('O usuário não está em nenhum canal de voz.');
			return voltarMenu();
		}
		let deveContinuar = true;
		let movimentosRealizados = 0;
		const canaisArray = Array.from(canaisVoz.values());
		let indiceAtual = 0;

		UIComponents.limparTela();
		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		const exibirTelaElevador = () => {
			if (!deveContinuar) return;

			atualizarPresenca({
				estado: `Movendo ${membro.user.username}`,
				detalhe: `Elevador: ${movimentosRealizados} movimentos`,
				imagemPequena:
					categoria.guild.iconURL({ dynamic: true, size: 256 }) ||
					'https://i.pinimg.com/736x/5c/d1/72/5cd172ee967ee3c703c3de27f1f240db.jpg',
				textoImagemPequena: `${categoria.guild.name}`
			});

			UIComponents.limparTela();
			exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

			UIComponents.exibirCabecalho('          ELEVADOR ATIVO', corPrincipal);
			UIComponents.exibirLinhaVazia();

			console.log(
				`        ${Simbolos.sucesso} Usuário: ${UIComponents.textoColorido(membro.user.tag, corPrincipal, false)}`
			);
			console.log(
				`        ${Simbolos.info} Categoria: ${UIComponents.textoColorido(categoria.name, corPrincipal, false)}`
			);
			console.log(
				`        ${Simbolos.info} Movimentos: ${UIComponents.textoColorido(movimentosRealizados.toString(), corPrincipal, false)}`
			);
			console.log(
				`        ${Simbolos.info} Canal atual: ${UIComponents.textoColorido(canaisArray[indiceAtual]?.name || 'N/A', corPrincipal, false)}`
			);
			UIComponents.exibirLinhaVazia();
			console.log(`        Pressione ${UIComponents.textoColorido('QUALQUER TECLA', corPrincipal, false)} para parar.`);
			UIComponents.exibirLinhaVazia();
		};

		exibirTelaElevador();

		const intervalMover = setInterval(async () => {
			if (!deveContinuar) return;

			try {
				const membroAtualizado = await categoria.guild.members.fetch(idUsuario);
				if (!membroAtualizado.voice.channelId) {
					deveContinuar = false;
					clearInterval(intervalMover);
					await exibirErro('O usuário saiu do canal de voz.');
					return;
				}

				indiceAtual = (indiceAtual + 1) % canaisArray.length;
				const proximoCanal = canaisArray[indiceAtual];

				await membroAtualizado.voice.setChannel(proximoCanal.id);
				movimentosRealizados++;
				exibirTelaElevador();
			} catch (err) {
				deveContinuar = false;
				clearInterval(intervalMover);
				await exibirErro(`Erro ao mover usuário: ${err.message}`);
			}
		}, 1000);

		await new Promise((resolve) => {
			const stdin = process.stdin;
			stdin.setRawMode(true);
			stdin.resume();
			stdin.setEncoding('utf8');

			const onData = () => {
				deveContinuar = false;
				clearInterval(intervalMover);
				stdin.setRawMode(false);
				stdin.pause();
				stdin.removeListener('data', onData);
				resolve();
			};

			stdin.on('data', onData);
		});

		atualizarPresenca({
			detalhe: 'No menu principal'
		});

		await voltarMenu();
	};

	const coleira = async () => {
		UIComponents.limparTela();
		UIComponents.definirTituloJanela('pkthegoat clear | Coleira');

		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho('          COLEIRA', corPrincipal);
		UIComponents.exibirLinhaVazia();
		UIComponents.exibirInfo('Digite o ID do servidor:', corPrincipal);
		UIComponents.exibirLinhaVazia();
		const idGuild = await readlineAsync.question(UIComponents.obterPrompt());
		const guild = client.guilds.cache.get(idGuild);
		if (!guild) {
			await exibirErro('Servidor não encontrado.');
			return voltarMenu();
		}

		UIComponents.limparTela();
		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho('          COLEIRA', corPrincipal);
		UIComponents.exibirLinhaVazia();
		UIComponents.exibirInfo('Digite os IDs dos usuários (separados por vírgula):', corPrincipal);
		UIComponents.exibirLinhaVazia();
		const idsInput = await readlineAsync.question(UIComponents.obterPrompt());

		const idsUsuarios = idsInput
			.split(',')
			.map((id) => id.trim())
			.filter((id) => id.length > 0);

		if (idsUsuarios.length === 0) {
			await exibirErro('Nenhum ID válido fornecido.');
			return voltarMenu();
		}

		const membros = [];
		for (const idUsuario of idsUsuarios) {
			const membro = await guild.members.fetch(idUsuario).catch(() => null);
			if (membro) {
				membros.push(membro);
			} else {
				await exibirErro(`Usuário ${idUsuario} não encontrado no servidor.`);
			}
		}

		if (membros.length === 0) {
			await exibirErro('Nenhum usuário válido encontrado.');
			return voltarMenu();
		}
		let deveContinuar = true;
		const puxadasPorUsuario = {};
		membros.forEach((m) => (puxadasPorUsuario[m.id] = 0));
		let ultimaAcao = 'Aguardando atividade...';

		const voiceUpdateListener = async (oldState, newState) => {
			if (!deveContinuar) return;

			if (oldState.guild.id !== guild.id && newState.guild.id !== guild.id) {
				return;
			}

			const idsMonitorados = membros.map((m) => m.id);

			if (idsMonitorados.includes(newState.member.id) && oldState.channelId !== newState.channelId) {
				if (newState.guild.id !== guild.id) {
					return;
				}

				try {
					const meuCanal = guild.members.me.voice.channelId;

					if (meuCanal) {
						const canalMeuNome = client.channels.cache.get(meuCanal)?.name || 'Desconhecido';

						if (!newState.channelId || newState.channelId !== meuCanal) {
							await newState.member.voice.setChannel(meuCanal);
							puxadasPorUsuario[newState.member.id]++;

							if (!oldState.channelId) {
								ultimaAcao = `${newState.member.user.username} entrou puxado para ${canalMeuNome}`;
							} else if (!newState.channelId) {
								ultimaAcao = `${newState.member.user.username} tentou sair puxado para ${canalMeuNome}`;
							} else {
								const canalAntigoNome = client.channels.cache.get(oldState.channelId)?.name || 'Desconhecido';
								ultimaAcao = `${newState.member.user.username}: ${canalAntigoNome} ${canalMeuNome}`;
							}
							exibirTelaColeira();
						}
					} else if (!newState.channelId && oldState.channelId) {
						ultimaAcao = `${newState.member.user.username} saiu (você não está em call)`;
						exibirTelaColeira();
					}
				} catch (err) {
					ultimaAcao = `Erro com ${newState.member.user.username}: ${err.message}`;
					exibirTelaColeira();
				}
			}

			if (newState.member.id === client.user.id) {
				if (newState.guild.id !== guild.id && oldState.guild.id !== guild.id) {
					return;
				}

				if (newState.guild.id === guild.id || oldState.guild.id === guild.id) {
					try {
						for (const membro of membros) {
							const membroAtualizado = await guild.members.fetch(membro.id).catch(() => null);
							if (!membroAtualizado) continue;

							if (newState.channelId && newState.guild.id === guild.id) {
								const canalNovo = newState.channel?.name || 'Desconhecido';

								if (membroAtualizado.voice.channelId !== newState.channelId) {
									await membroAtualizado.voice.setChannel(newState.channelId);
									puxadasPorUsuario[membro.id]++;
									ultimaAcao = `Você ${canalNovo} | ${membro.user.username} puxado`;
								}
							}
						}
						exibirTelaColeira();
					} catch (err) {
						ultimaAcao = `Erro: ${err.message}`;
						exibirTelaColeira();
					}
				}
			}
		};

		client.on('voiceStateUpdate', voiceUpdateListener);

		const exibirTelaColeira = () => {
			if (!deveContinuar) return;

			const meuCanalId = guild.members.me.voice.channelId;
			const canalNome = meuCanalId ? client.channels.cache.get(meuCanalId)?.name || 'Desconhecido' : 'Nenhum';
			const totalPuxadas = Object.values(puxadasPorUsuario).reduce((a, b) => a + b, 0);

			atualizarPresenca({
				estado: `${membros.length} usuário(s) na coleira`,
				detalhe: `Coleira: ${totalPuxadas} puxadas`,
				imagemPequena:
					guild.iconURL({ dynamic: true, size: 256 }) ||
					'https://i.pinimg.com/736x/5c/d1/72/5cd172ee967ee3c703c3de27f1f240db.jpg',
				textoImagemPequena: `${guild.name}`
			});

			UIComponents.limparTela();
			exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

			UIComponents.exibirCabecalho('          COLEIRA ATIVA', corPrincipal);
			UIComponents.exibirLinhaVazia();

			console.log(`        ${Simbolos.info} Servidor: ${UIComponents.textoColorido(guild.name, corPrincipal, false)}`);
			console.log(
				`        ${Simbolos.info} Canal atual: ${UIComponents.textoColorido(canalNome, corPrincipal, false)}`
			);
			console.log(
				`        ${Simbolos.info} Total de puxadas: ${UIComponents.textoColorido(totalPuxadas.toString(), corPrincipal, false)}`
			);
			UIComponents.exibirLinhaVazia();

			console.log(`        ${Simbolos.sucesso} Usuários na coleira:`);
			membros.forEach((membro) => {
				const puxadas = puxadasPorUsuario[membro.id] || 0;
				console.log(
					`           ${UIComponents.textoColorido(membro.user.tag, corPrincipal, false)} - ${UIComponents.textoColorido(puxadas.toString(), corPrincipal, false)} puxadas`
				);
			});

			UIComponents.exibirLinhaVazia();
			console.log(
				`        ${Simbolos.info} Última ação: ${UIComponents.textoColorido(ultimaAcao, corPrincipal, false)}`
			);
			UIComponents.exibirLinhaVazia();
			console.log(`        Pressione ${UIComponents.textoColorido('ENTER', corPrincipal, false)} para parar.`);
			UIComponents.exibirLinhaVazia();
		};

		exibirTelaColeira();

		await new Promise((resolve) => {
			const stdin = process.stdin;
			stdin.setRawMode(true);
			stdin.resume();
			stdin.setEncoding('utf8');

			const onData = (key) => {
				if (key === '\r' || key === '\n' || key.charCodeAt(0) === 13) {
					deveContinuar = false;
					client.off('voiceStateUpdate', voiceUpdateListener);
					stdin.setRawMode(false);
					stdin.pause();
					stdin.removeListener('data', onData);
					resolve();
				}
			};

			stdin.on('data', onData);
		});

		atualizarPresenca({
			detalhe: 'No menu principal'
		});

		await voltarMenu();
	};
	const protegerUsuario = async () => {
		UIComponents.limparTela();
		UIComponents.definirTituloJanela('pkthegoat clear | Proteger Usuário');

		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho('          PROTEGER USUÁRIO', corPrincipal);
		UIComponents.exibirLinhaVazia();
		UIComponents.exibirInfo('Digite o ID do servidor:', corPrincipal);
		UIComponents.exibirLinhaVazia();

		const idGuild = await readlineAsync.question(UIComponents.obterPrompt());
		const guild = client.guilds.cache.get(idGuild);

		if (!guild) {
			await exibirErro('Servidor não encontrado.');
			return voltarMenu();
		}

		UIComponents.limparTela();
		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

		UIComponents.exibirCabecalho('          PROTEGER USUÁRIO', corPrincipal);
		UIComponents.exibirLinhaVazia();
		UIComponents.exibirInfo('Digite os IDs dos usuários (separados por vírgula):', corPrincipal);
		UIComponents.exibirLinhaVazia();

		const idsInput = await readlineAsync.question(UIComponents.obterPrompt());

		const idsUsuarios = idsInput
			.split(',')
			.map((id) => id.trim())
			.filter((id) => id.length > 0);

		if (idsUsuarios.length === 0) {
			await exibirErro('Nenhum ID válido fornecido.');
			return voltarMenu();
		}

		const membros = [];
		for (const idUsuario of idsUsuarios) {
			const membro = await guild.members.fetch(idUsuario).catch(() => null);
			if (membro) {
				membros.push(membro);
			} else {
				await exibirErro(`Usuário ${idUsuario} não encontrado no servidor.`);
			}
		}

		if (membros.length === 0) {
			await exibirErro('Nenhum usuário válido encontrado.');
			return voltarMenu();
		}

		UIComponents.limparTela();
		exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);
		UIComponents.exibirCabecalho('          MODO DE EXECUÇÃO', corPrincipal);
		UIComponents.exibirLinhaVazia();
		UIComponents.exibirOpcaoMenu('1', 'Executar em primeiro plano (bloqueante)', corPrincipal);
		UIComponents.exibirOpcaoMenu('2', 'Executar em segundo plano (retorna ao menu)', corPrincipal);
		UIComponents.exibirLinhaVazia();

		const modoExecucao = await readlineAsync.question(UIComponents.obterPrompt());
		const emSegundoPlano = modoExecucao === '2';

		let deveContinuar = true;
		const protecoesPorUsuario = {};
		membros.forEach((m) => (protecoesPorUsuario[m.id] = 0));
		let ultimaAcao = 'Aguardando atividade...';

		const pararProtecao = async () => {
			deveContinuar = false;
			if (voiceUpdateListener) {
				client.off('voiceStateUpdate', voiceUpdateListener);
			}
			atualizarPresenca({
				detalhe: 'No menu principal'
			});
		};

		const exibirTelaProtecao = () => {
			if (!deveContinuar) return;

			const totalProtecoes = Object.values(protecoesPorUsuario).reduce((a, b) => a + b, 0);
			const nomeGuild = guild?.name || 'Servidor Desconhecido';
			const iconGuild = guild?.iconURL({ dynamic: true, size: 256 }) || 
				'https://i.pinimg.com/736x/5c/d1/72/5cd172ee967ee3c703c3de27f1f240db.jpg';

			atualizarPresenca({
				estado: `Protegendo ${membros.length} usuário(s)`,
				detalhe: `Proteções: ${totalProtecoes}`,
				imagemPequena: iconGuild,
				textoImagemPequena: nomeGuild
			});

			if (!emSegundoPlano) {
				UIComponents.limparTela();
				exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);

				UIComponents.exibirCabecalho('          PROTEÇÃO ATIVA', corPrincipal);
				UIComponents.exibirLinhaVazia();

				console.log(`        ${Simbolos.info} Servidor: ${UIComponents.textoColorido(nomeGuild, corPrincipal, false)}`);
				console.log(
					`        ${Simbolos.info} Total de proteções: ${UIComponents.textoColorido(totalProtecoes.toString(), corPrincipal, false)}`
				);
				UIComponents.exibirLinhaVazia();

				console.log(`        ${Simbolos.sucesso} Usuários protegidos:`);
				membros.forEach((membro) => {
					const protecoes = protecoesPorUsuario[membro.id] || 0;
					const userTag = membro?.user?.tag || 'Usuário Desconhecido';
					console.log(
						`           ${UIComponents.textoColorido(userTag, corPrincipal, false)} - ${UIComponents.textoColorido(protecoes.toString(), corPrincipal, false)} proteções`
					);
				});

				UIComponents.exibirLinhaVazia();
				console.log(
					`        ${Simbolos.info} Última ação: ${UIComponents.textoColorido(ultimaAcao, corPrincipal, false)}`
				);
				UIComponents.exibirLinhaVazia();
				console.log(
					`        ${UIComponents.textoColorido('', corPrincipal, false)} Anti-MUTE: ${UIComponents.textoColorido('ATIVO', corPrincipal, false)}`
				);
				console.log(
					`        ${UIComponents.textoColorido('', corPrincipal, false)} Anti-DEAF: ${UIComponents.textoColorido('ATIVO', corPrincipal, false)}`
				);
				UIComponents.exibirLinhaVazia();
				console.log(`        Pressione ${UIComponents.textoColorido('ENTER', corPrincipal, false)} para parar.`);
				UIComponents.exibirLinhaVazia();
			}
		};

		const voiceUpdateListener = async (oldState, newState) => {
			if (!deveContinuar) return;

			const idsMonitorados = membros.map((m) => m.id);
			if (!idsMonitorados.includes(newState.member.id)) return;

			if (newState.guild.id !== guild.id) return;

			try {
				let acaoRealizada = false;

				if (newState.mute && !oldState.mute) {
					await newState.member.voice.setMute(false);
					protecoesPorUsuario[newState.member.id]++;
					ultimaAcao = `${newState.member.user.username}: Removido MUTE`;
					acaoRealizada = true;
				}

				if (newState.deaf && !oldState.deaf) {
					await newState.member.voice.setDeaf(false);
					protecoesPorUsuario[newState.member.id]++;
					ultimaAcao = `${newState.member.user.username}: Removido DEAF`;
					acaoRealizada = true;
				}

				if (newState.mute && newState.deaf && (!oldState.mute || !oldState.deaf)) {
					await newState.member.voice.setMute(false);
					await newState.member.voice.setDeaf(false);
					protecoesPorUsuario[newState.member.id] += 2;
					ultimaAcao = `${newState.member.user.username}: Removido MUTE + DEAF`;
					acaoRealizada = true;
				}

				if (acaoRealizada) {
					exibirTelaProtecao();
				}
			} catch (err) {
				ultimaAcao = `Erro com ${newState.member.user.username}: ${err.message}`;
				exibirTelaProtecao();
			}
		};

		client.on('voiceStateUpdate', voiceUpdateListener);

		if (emSegundoPlano) {
			const usuariosNomes = membros.map(m => m?.user?.username || 'Usuário').join(', ');
			const nomeGuild = guild?.name || 'Servidor Desconhecido';
			
			const taskId = backgroundTaskManager.addTask(
				`Proteger: ${usuariosNomes}`,
				pararProtecao,
				{
					guild: nomeGuild,
					usuarios: membros.map(m => ({ id: m.id, username: m?.user?.username || 'Usuário' })),
					protecoes: protecoesPorUsuario
				}
			);

			UIComponents.limparTela();
			exibirTitulo(client?.user?.username || 'Desconhecido', client?.user?.id || '0', corPrincipal);
			UIComponents.exibirCabecalho('          PROTEÇÃO EM SEGUNDO PLANO', corPrincipal);
			UIComponents.exibirLinhaVazia();
			UIComponents.exibirSucesso(`Proteção iniciada em segundo plano!`, corPrincipal);
			UIComponents.exibirInfo(`Servidor: ${nomeGuild}`, corPrincipal);
			UIComponents.exibirInfo(`Usuários protegidos: ${membros.length}`, corPrincipal);
			UIComponents.exibirInfo(`Você pode gerenciar esta tarefa no menu principal`, corPrincipal);
			UIComponents.exibirLinhaVazia();
			await sleep(CONSTANTS.DELAYS.SHORT_PAUSE);

			return await voltarMenu();
		}

		exibirTelaProtecao();

		await new Promise((resolve) => {
			const stdin = process.stdin;
			stdin.setRawMode(true);
			stdin.resume();
			stdin.setEncoding('utf8');

			const onData = (key) => {
				if (key === '\r' || key === '\n' || key.charCodeAt(0) === 13) {
					stdin.setRawMode(false);
					stdin.pause();
					stdin.removeListener('data', onData);
					resolve();
				}
			};

			stdin.on('data', onData);
		});

		await pararProtecao();
		await voltarMenu();
	};
	const acoesMenu = [
		{ id: '1', action: () => desconectarTodos() },
		{ id: '2', action: () => moverMembros() },
		{ id: '3', action: () => farmarHoras() },
		{ id: '4', action: () => mutarDesmutarTodos() },
		{ id: '5', action: () => ensurdecerDesensurdecerTodos() },
		{ id: '6', action: () => listarMembros() },
		{ id: '7', action: () => elevador() },
		{ id: '8', action: () => coleira() },
		{ id: '9', action: () => protegerUsuario() },
		{ id: '0', action: () => voltarMenu() }
	];

	const acaoEncontrada = acoesMenu.find((item) => item.id === opcao);

	if (acaoEncontrada) {
		return await acaoEncontrada.action();
	} else {
		await exibirErro('Op��o inv�lida.');
		return voltarMenu();
	}
}

module.exports = {
	utilidadesCall,
	menuUtilsCalls: utilidadesCall
};

