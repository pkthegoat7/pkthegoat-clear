const { test } = require('node:test');
const assert = require('node:assert');
const totp = require('../src/services/totp');

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 de "12345678901234567890"

test('base32 roundtrip', () => {
    const original = Buffer.from('12345678901234567890', 'utf8');
    assert.strictEqual(totp.base32Encode(original), SECRET);
    assert.ok(totp.base32Decode(SECRET).equals(original));
});

test('vetores RFC 6238 (6 dígitos, SHA1, passo 30s)', () => {
    const casos = [
        [59, '287082'],
        [1111111109, '081804'],
        [1111111111, '050471'],
        [1234567890, '005924'],
        [2000000000, '279037'],
    ];
    for (const [segundos, esperado] of casos) {
        assert.strictEqual(totp.codigoTotp(SECRET, segundos * 1000), esperado, `t=${segundos}`);
    }
});

test('verificar aceita o código atual e rejeita um errado', () => {
    const t = 1111111111 * 1000;
    assert.strictEqual(totp.verificar(SECRET, '050471', t), true);
    assert.strictEqual(totp.verificar(SECRET, '000000', t), false);
});

test('verificar tolera janela de ±1 passo (clock skew)', () => {
    const t = 1111111111 * 1000;
    const anterior = totp.codigoTotp(SECRET, t - 30 * 1000);
    const seguinte = totp.codigoTotp(SECRET, t + 30 * 1000);
    assert.strictEqual(totp.verificar(SECRET, anterior, t), true);
    assert.strictEqual(totp.verificar(SECRET, seguinte, t), true);
});

test('verificar rejeita formato inválido', () => {
    assert.strictEqual(totp.verificar(SECRET, '12', Date.now()), false);
    assert.strictEqual(totp.verificar(SECRET, 'abcdef', Date.now()), false);
    assert.strictEqual(totp.verificar(SECRET, null, Date.now()), false);
});

test('montarUri gera otpauth válido', () => {
    const uri = totp.montarUri('user@x.com', SECRET);
    assert.ok(uri.startsWith('otpauth://totp/pkthegoat:user%40x.com?'));
    assert.ok(uri.includes(`secret=${SECRET}`));
    assert.ok(uri.includes('issuer=pkthegoat'));
});
