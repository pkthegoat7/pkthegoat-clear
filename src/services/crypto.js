/**
 * Criptografia simetrica para tokens Discord armazenados no Supabase.
 * AES-256-GCM com chave de 32 bytes derivada de ENCRYPTION_KEY (env).
 */

const { createCipheriv, createDecipheriv, randomBytes, scryptSync } = require('crypto');

const ALG = 'aes-256-gcm';
let chaveCache = null;

function obterChave() {
    if (chaveCache) return chaveCache;
    const env = process.env.ENCRYPTION_KEY;
    if (!env) {
        throw new Error('ENCRYPTION_KEY não definida no ambiente. Gere uma com `openssl rand -base64 32`.');
    }
    // Deriva 32 bytes determinísticos a partir da string da env.
    chaveCache = scryptSync(env, 'pkthegoat-painel-salt', 32);
    return chaveCache;
}

function cifrarToken(plain) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALG, obterChave(), iv);
    const cifrado = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        token_cifrado: cifrado.toString('base64'),
        iv: iv.toString('base64'),
        auth_tag: authTag.toString('base64')
    };
}

function decifrarToken({ token_cifrado, iv, auth_tag }) {
    const decipher = createDecipheriv(ALG, obterChave(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(auth_tag, 'base64'));
    const dec = Buffer.concat([
        decipher.update(Buffer.from(token_cifrado, 'base64')),
        decipher.final()
    ]);
    return dec.toString('utf8');
}

module.exports = { cifrarToken, decifrarToken };
