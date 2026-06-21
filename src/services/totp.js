/**
 * TOTP (RFC 6238) com crypto nativo — sem dependência externa.
 * HMAC-SHA1, passo de 30s, 6 dígitos. Segredo em base32 (compatível com otpauth://).
 */
const { createHmac, randomBytes, timingSafeEqual } = require('crypto');

const BASE32_ALFA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
    let bits = 0, valor = 0, saida = '';
    for (const byte of buf) {
        valor = (valor << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            saida += BASE32_ALFA[(valor >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) saida += BASE32_ALFA[(valor << (5 - bits)) & 31];
    return saida;
}

function base32Decode(str) {
    const limpo = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
    let bits = 0, valor = 0;
    const bytes = [];
    for (const ch of limpo) {
        const idx = BASE32_ALFA.indexOf(ch);
        if (idx === -1) throw new Error('Base32 inválido');
        valor = (valor << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((valor >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

function gerarSegredo(bytes = 20) {
    return base32Encode(randomBytes(bytes));
}

function gerarCodigo(secretBase32, contador) {
    const chave = base32Decode(secretBase32);
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(contador / 0x100000000), 0);
    buf.writeUInt32BE(contador >>> 0, 4);
    const hmac = createHmac('sha1', chave).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const bin = ((hmac[offset] & 0x7f) << 24)
        | ((hmac[offset + 1] & 0xff) << 16)
        | ((hmac[offset + 2] & 0xff) << 8)
        | (hmac[offset + 3] & 0xff);
    return String(bin % 1000000).padStart(6, '0');
}

function codigoTotp(secretBase32, tMs = Date.now(), passo = 30) {
    return gerarCodigo(secretBase32, Math.floor((tMs / 1000) / passo));
}

function verificar(secretBase32, codigo, tMs = Date.now(), janela = 1, passo = 30) {
    if (!/^\d{6}$/.test(String(codigo || ''))) return false;
    const contadorBase = Math.floor((tMs / 1000) / passo);
    const alvo = Buffer.from(String(codigo));
    for (let i = -janela; i <= janela; i++) {
        const esperado = Buffer.from(gerarCodigo(secretBase32, contadorBase + i));
        if (esperado.length === alvo.length && timingSafeEqual(esperado, alvo)) return true;
    }
    return false;
}

function montarUri(email, secretBase32, emissor = 'pkthegoat') {
    const label = `${encodeURIComponent(emissor)}:${encodeURIComponent(email)}`;
    const params = new URLSearchParams({
        secret: secretBase32, issuer: emissor, algorithm: 'SHA1', digits: '6', period: '30'
    });
    return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = { base32Encode, base32Decode, gerarSegredo, gerarCodigo, codigoTotp, verificar, montarUri };
