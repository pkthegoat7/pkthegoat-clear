'use strict';

/**
 * Ponte de captcha entre o self (lib) e o painel.
 *
 * A discord.js-selfbot-v13 chama client.options.captchaSolver(data) quando um
 * request bate em captcha. Aqui a gente registra esse captcha como "pendente"
 * por usuário (email do contexto) e devolve uma Promise que só resolve quando o
 * painel enviar o token do hCaptcha. Aí a lib reenvia o request com o token
 * (headers X-Captcha-Key + X-Captcha-Rqtoken) e a ação completa.
 */

const pendentes = new Map(); // emailLower -> { data, resolve, reject, criadoEm }

function chaveDe(email) {
	return String(email || '').toLowerCase();
}

// Chamado pelo captchaSolver do client. Retorna Promise<token>.
function solicitarCaptcha(email, data, timeoutMs = 180000) {
	const chave = chaveDe(email);
	const antigo = pendentes.get(chave);
	if (antigo) {
		try {
			antigo.reject(new Error('captcha substituído por um novo'));
		} catch {}
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendentes.delete(chave);
			reject(new Error('captcha: tempo esgotado (ninguém resolveu no painel)'));
		}, timeoutMs);
		pendentes.set(chave, {
			data: data || {},
			criadoEm: Date.now(),
			resolve: (token) => {
				clearTimeout(timer);
				pendentes.delete(chave);
				resolve(token);
			},
			reject: (e) => {
				clearTimeout(timer);
				pendentes.delete(chave);
				reject(e);
			}
		});
	});
}

// Para o painel: dados do captcha pendente (ou null).
function pendente(email) {
	const p = pendentes.get(chaveDe(email));
	if (!p) return null;
	return {
		sitekey: p.data.captcha_sitekey || null,
		rqdata: p.data.captcha_rqdata || null,
		service: p.data.captcha_service || 'hcaptcha',
		criadoEm: p.criadoEm
	};
}

// Painel enviou o token resolvido.
function resolverCaptcha(email, token) {
	const p = pendentes.get(chaveDe(email));
	if (!p || !token) return false;
	p.resolve(String(token));
	return true;
}

function cancelarCaptcha(email) {
	const p = pendentes.get(chaveDe(email));
	if (!p) return false;
	p.reject(new Error('captcha cancelado pelo usuário'));
	return true;
}

module.exports = { solicitarCaptcha, pendente, resolverCaptcha, cancelarCaptcha };
