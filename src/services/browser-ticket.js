/**
 * Emite o ticket HMAC que autoriza o serviço self-browser a abrir o Discord web
 * do self. Mesmo esquema do self-browser/ticket.js. O segredo
 * (BROWSER_SHARED_SECRET) é compartilhado entre painel e serviço.
 */

const { createHmac } = require('crypto');

function emitirTicket({ email, nome }, segredo, ttlMs = 30_000) {
    const payload = { email, nome, exp: Date.now() + ttlMs };
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = createHmac('sha256', segredo).update(payloadB64).digest('base64url');
    return payloadB64 + '.' + sig;
}

// Monta a URL WS do serviço a partir de SELF_BROWSER_URL (http(s) ou ws(s)).
function urlStream(base, ticket) {
    const limpa = String(base).replace(/\/+$/, '');
    const ws = limpa.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    return `${ws}/stream?ticket=${encodeURIComponent(ticket)}`;
}

module.exports = { emitirTicket, urlStream };
