/**
 * Ticket HMAC curto que autoriza abrir um browser do self. Emitido pelo painel
 * (que valida a sessão do usuário) e verificado aqui. Formato:
 *   base64url(JSON({email, nome, exp})) + "." + base64url(HMAC_SHA256(payload, segredo))
 * O segredo (BROWSER_SHARED_SECRET) é compartilhado painel <-> serviço.
 */

const { createHmac, timingSafeEqual } = require('crypto');

function assinar(payloadB64, segredo) {
    return createHmac('sha256', segredo).update(payloadB64).digest('base64url');
}

// Retorna { email, nome } se válido e não expirado; senão null.
function verificarTicket(ticket, segredo) {
    if (!ticket || !segredo) return null;
    const partes = String(ticket).split('.');
    if (partes.length !== 2) return null;
    const [payloadB64, sig] = partes;
    const esperada = assinar(payloadB64, segredo);
    const a = Buffer.from(sig);
    const b = Buffer.from(esperada);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    let dados;
    try { dados = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); } catch { return null; }
    if (!dados || !dados.email || !dados.nome || !dados.exp) return null;
    if (Date.now() > Number(dados.exp)) return null;
    return { email: dados.email, nome: dados.nome };
}

// Usado opcionalmente para testes locais; o painel tem a sua própria cópia.
function emitirTicket({ email, nome }, segredo, ttlMs = 30_000) {
    const payload = { email, nome, exp: Date.now() + ttlMs };
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return payloadB64 + '.' + assinar(payloadB64, segredo);
}

module.exports = { verificarTicket, emitirTicket };
