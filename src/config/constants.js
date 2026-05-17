module.exports = {
	UI: {
		SEPARATOR: '═══════════════════════════════════════════════════════',
		PADDING: '        ',
		SPACE: '   ',
		PROMPT: '        > ',
		NEWLINE: '\n'
	},

	COLORS: {
		RAINBOW: 'rainbow'
	},

	DISCORD: {
		CHANNEL_TYPES: {
			DM: 'DM',
			GUILD_TEXT: 'GUILD_TEXT',
			GUILD_VOICE: 'GUILD_VOICE',
			GUILD_CATEGORY: 'GUILD_CATEGORY',
			GUILD_NEWS: 'GUILD_NEWS',
			GUILD_STAGE_VOICE: 'GUILD_STAGE_VOICE'
		},

		RELATIONSHIP_TYPES: {
			NONE: 0,
			FRIEND: 1,
			BLOCKED: 2,
			PENDING_INCOMING: 3,
			PENDING_OUTGOING: 4
		}
	},

	DELAYS: {
		ROLE_CREATION: 0.3,
		CATEGORY_CREATION: 0.5,
		CHANNEL_CREATION: 0.5,
		EMOJI_CREATION: 0.5,
		STICKER_CREATION: 1,

		DM_CLOSE: 1.3,
		ERROR_RETRY: 1,

		MESSAGE_DISPLAY: 2,
		SHORT_PAUSE: 1,
		LONG_PAUSE: 3
	},

	LIMITS: {
		FETCH_MESSAGES_BATCH: 100,
		DISCORD_SNOWFLAKE_MIN: 17,
		DISCORD_SNOWFLAKE_MAX: 19
	},

	WINDOW_TITLES: {
		MAIN_MENU: 'pkthegoat clear | Menu Principal',
		CLONE_SERVER: 'pkthegoat clear | Clonar servidor',
		CLEAN_DM: 'pkthegoat clear | Limpar DM única',
		CLEAN_DMS: 'pkthegoat clear | Limpar DMs abertas',
		REMOVE_FRIENDS: 'pkthegoat clear | Remover amigos',
		REMOVE_SERVERS: 'pkthegoat clear | Remover servidores',
		CLOSE_DMS: 'pkthegoat clear | Fechar DMs',
		CONFIG: 'pkthegoat clear | Configuração',
		BACKUP: 'pkthegoat clear | Backup de mensagens',
		USER_INFO: 'pkthegoat clear | Informações do usuário',
		OPEN_DMS: 'pkthegoat clear | Abrir DMs',
		CONNECTING: 'pkthegoat clear | Conectando...',
		INITIALIZING: 'pkthegoat clear | Inicializando...',
		CONFIGURE_RPC: 'pkthegoat clear | Configurar Rich Presence',
		UPDATE_MENU: 'pkthegoat clear | Atualizações',
		SELECT_TOKEN: 'pkthegoat clear | Selecionar token',
		LOGIN: 'pkthegoat clear | Login'
	}
};
