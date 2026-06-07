/**
 * Criptografia simetrica para tokens Discord armazenados no Supabase.
 * AES-256-GCM com chave de 32 bytes derivada de ENCRYPTION_KEY (env).
 */

const { createCipheriv, createDecipheriv, randomBytes, scryptSync } = require('crypto');

const ALG = 'aes-256-gcm';
const MIN_ENTROPY_BYTES = 32;
const SALT = 'pkthegoat-painel-salt';
let chaveCache = null;
let chaveLegacyCache = null;

function obterChave() {
    if (chaveCache) return chaveCache;
    const env = process.env.ENCRYPTION_KEY;
    if (!env) {
        throw new Error('ENCRYPTION_KEY não definida no ambiente. Gere uma com `openssl rand -base64 32`.');
    }
    // Salt fixo permite chave determinística a partir da env, mas só é seguro se
    // a env for de alta entropia. Bloqueia explicitamente strings curtas/fracas.
    const envBytes = Buffer.byteLength(env, 'utf8');
    if (envBytes < MIN_ENTROPY_BYTES) {
        throw new Error(
            `ENCRYPTION_KEY tem ${envBytes} bytes — mínimo ${MIN_ENTROPY_BYTES}. ` +
            'Gere com `openssl rand -base64 32` ou equivalente. ' +
            'Como o salt é fixo, uma chave fraca permite força bruta dos tokens cifrados.'
        );
    }
    chaveCache = scryptSync(env, SALT, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return chaveCache;
}

// Chave derivada com os parâmetros antigos do scrypt (N padrão = 2^14). Usada
// apenas para decifrar tokens gravados antes do commit de hardening (e7b6ab9).
// Sem o fallback, todos os tokens salvos viram lixo após o deploy do novo scrypt.
function obterChaveLegacy() {
    if (chaveLegacyCache) return chaveLegacyCache;
    const env = process.env.ENCRYPTION_KEY;
    if (!env) return null;
    chaveLegacyCache = scryptSync(env, SALT, 32);
    return chaveLegacyCache;
}

function tentarDecifrarComChave(chave, ivBuf, tagBuf, dadosBuf) {
    const decipher = createDecipheriv(ALG, chave, ivBuf);
    decipher.setAuthTag(tagBuf);
    const dec = Buffer.concat([decipher.update(dadosBuf), decipher.final()]);
    return dec.toString('utf8');
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
    const ivBuf = Buffer.from(iv, 'base64');
    const tagBuf = Buffer.from(auth_tag, 'base64');
    const dadosBuf = Buffer.from(token_cifrado, 'base64');
    try {
        return tentarDecifrarComChave(obterChave(), ivBuf, tagBuf, dadosBuf);
    } catch (erro) {
        const chaveAntiga = obterChaveLegacy();
        if (!chaveAntiga) throw erro;
        return tentarDecifrarComChave(chaveAntiga, ivBuf, tagBuf, dadosBuf);
    }
}

module.exports = { cifrarToken, decifrarToken };
