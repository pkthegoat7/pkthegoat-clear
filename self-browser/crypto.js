/**
 * Decifra tokens Discord guardados no Supabase (AES-256-GCM, chave derivada de
 * ENCRYPTION_KEY). Cópia compatível com src/services/crypto.js do painel — os
 * dois serviços PRECISAM usar o mesmo ENCRYPTION_KEY para decifrar os mesmos
 * tokens.
 */

const { createDecipheriv, scryptSync } = require('crypto');

const ALG = 'aes-256-gcm';
const MIN_ENTROPY_BYTES = 32;
const SALT = 'pkthegoat-painel-salt';
let chaveCache = null;
let chaveLegacyCache = null;

function obterChave() {
    if (chaveCache) return chaveCache;
    const env = process.env.ENCRYPTION_KEY;
    if (!env) throw new Error('ENCRYPTION_KEY não definida.');
    const envBytes = Buffer.byteLength(env, 'utf8');
    if (envBytes < MIN_ENTROPY_BYTES) {
        throw new Error(`ENCRYPTION_KEY tem ${envBytes} bytes — mínimo ${MIN_ENTROPY_BYTES}.`);
    }
    chaveCache = scryptSync(env, SALT, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return chaveCache;
}

function obterChaveLegacy() {
    if (chaveLegacyCache) return chaveLegacyCache;
    const env = process.env.ENCRYPTION_KEY;
    if (!env) return null;
    chaveLegacyCache = scryptSync(env, SALT, 32);
    return chaveLegacyCache;
}

function tentar(chave, ivBuf, tagBuf, dadosBuf) {
    const decipher = createDecipheriv(ALG, chave, ivBuf);
    decipher.setAuthTag(tagBuf);
    return Buffer.concat([decipher.update(dadosBuf), decipher.final()]).toString('utf8');
}

function decifrarToken({ token_cifrado, iv, auth_tag }) {
    const ivBuf = Buffer.from(iv, 'base64');
    const tagBuf = Buffer.from(auth_tag, 'base64');
    const dadosBuf = Buffer.from(token_cifrado, 'base64');
    try {
        return tentar(obterChave(), ivBuf, tagBuf, dadosBuf);
    } catch (erro) {
        const antiga = obterChaveLegacy();
        if (!antiga) throw erro;
        return tentar(antiga, ivBuf, tagBuf, dadosBuf);
    }
}

module.exports = { decifrarToken };
