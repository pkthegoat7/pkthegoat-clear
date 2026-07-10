const test = require('node:test');
const assert = require('node:assert/strict');

const oauth = require('../src/services/discord-oauth');

test('trocarCodigoDetalhado preserva erro invalid_client sem expor segredo', async () => {
    const oldFetch = global.fetch;
    const oldClientId = process.env.DISCORD_CLIENT_ID;
    const oldSecret = process.env.DISCORD_CLIENT_SECRET;
    process.env.DISCORD_CLIENT_ID = 'client-id';
    process.env.DISCORD_CLIENT_SECRET = 'secret-value';
    try {
        global.fetch = async (_url, opts) => {
            assert.equal(opts.method, 'POST');
            const body = String(opts.body);
            assert.match(body, /client_id=client-id/);
            assert.match(body, /client_secret=secret-value/);
            return {
                ok: false,
                status: 401,
                json: async () => ({ error: 'invalid_client', error_description: 'Bad credentials' })
            };
        };

        const r = await oauth.trocarCodigoDetalhado('code', 'https://self.disclaw.cc/api/auth/discord/callback');
        assert.deepEqual(r, { sucesso: false, status: 401, erro: 'invalid_client' });
    } finally {
        global.fetch = oldFetch;
        if (oldClientId === undefined) delete process.env.DISCORD_CLIENT_ID;
        else process.env.DISCORD_CLIENT_ID = oldClientId;
        if (oldSecret === undefined) delete process.env.DISCORD_CLIENT_SECRET;
        else process.env.DISCORD_CLIENT_SECRET = oldSecret;
    }
});

test('trocarCodigo mantém contrato token|null para callers antigos', async () => {
    const oldFetch = global.fetch;
    const oldClientId = process.env.DISCORD_CLIENT_ID;
    const oldSecret = process.env.DISCORD_CLIENT_SECRET;
    process.env.DISCORD_CLIENT_ID = 'client-id';
    process.env.DISCORD_CLIENT_SECRET = 'secret-value';
    try {
        global.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'access-token' })
        });
        assert.equal(await oauth.trocarCodigo('code', 'https://self.disclaw.cc/api/auth/discord/callback'), 'access-token');
    } finally {
        global.fetch = oldFetch;
        if (oldClientId === undefined) delete process.env.DISCORD_CLIENT_ID;
        else process.env.DISCORD_CLIENT_ID = oldClientId;
        if (oldSecret === undefined) delete process.env.DISCORD_CLIENT_SECRET;
        else process.env.DISCORD_CLIENT_SECRET = oldSecret;
    }
});
