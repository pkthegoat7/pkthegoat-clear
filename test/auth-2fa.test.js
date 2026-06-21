process.env.ENCRYPTION_KEY = 'chave-de-teste-com-mais-de-32-bytes-aaaaaaaa';
const { test } = require('node:test');
const assert = require('node:assert');
const auth = require('../src/services/auth');
const totp = require('../src/services/totp');

test('gerarCodigosBackup gera N códigos com hashes correspondentes', () => {
    const { codigos, hashes } = auth.gerarCodigosBackup(10);
    assert.strictEqual(codigos.length, 10);
    assert.strictEqual(hashes.length, 10);
    assert.ok(codigos.every((c) => /^[0-9a-f]{10}$/.test(c)));
});

test('verificarCodigoBackup valida e consome um código (uso único)', () => {
    const { codigos, hashes } = auth.gerarCodigosBackup(3);
    const r1 = auth.verificarCodigoBackup(codigos[1], hashes);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.hashesRestantes.length, 2);
    const r2 = auth.verificarCodigoBackup(codigos[1], r1.hashesRestantes);
    assert.strictEqual(r2.ok, false);
});

test('verificarCodigoBackup rejeita código inexistente', () => {
    const { hashes } = auth.gerarCodigosBackup(3);
    assert.strictEqual(auth.verificarCodigoBackup('zzzzzzzzzz', hashes).ok, false);
});

test('cifrar/decifrar segredo TOTP roundtrip', () => {
    const segredo = totp.gerarSegredo();
    const blob = auth.cifrarSegredoTotp(segredo);
    assert.notStrictEqual(blob, segredo);
    assert.strictEqual(auth.decifrarSegredoTotp(blob), segredo);
});

test('desafio 2FA: cria, obtém, conta tentativas e expira no cap', () => {
    const id = auth.criarDesafio2fa('User@X.com');
    const d = auth.obterDesafio2fa(id);
    assert.strictEqual(d.email, 'user@x.com');
    for (let i = 0; i < 5; i++) auth.registrarTentativaDesafio(id);
    assert.strictEqual(auth.obterDesafio2fa(id), null);
});

test('desafio 2FA: consumir remove o desafio', () => {
    const id = auth.criarDesafio2fa('a@b.com');
    auth.consumirDesafio2fa(id);
    assert.strictEqual(auth.obterDesafio2fa(id), null);
});
