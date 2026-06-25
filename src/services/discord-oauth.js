/**
 * Login via Discord (OAuth2, fluxo "authorization code").
 *
 * Requer envs:
 *   DISCORD_CLIENT_ID       (portal de devs do Discord -> sua aplicação -> OAuth2)
 *   DISCORD_CLIENT_SECRET   (idem; NUNCA expor no frontend)
 *
 * O redirect_uri é montado em web-ui-server.js (a partir do host do request ou de
 * PKTHEGOAT_BASE_URL/DISCORD_REDIRECT_URI) e precisa estar cadastrado IGUALZINHO
 * no portal do Discord, senão o Discord recusa o login.
 *
 * Usa o fetch nativo do Node (>=18). Sem dependência nova.
 */

const AUTORIZE_URL = 'https://discord.com/api/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const ME_URL = 'https://discord.com/api/users/@me';
// identify: id + username/avatar. email: para casar com contas existentes por email.
const SCOPE = 'identify email';

function estaConfigurado() {
    return !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
}

// URL para onde o usuário é mandado ao clicar em "Entrar com Discord".
function urlAutorizacao(redirectUri, state) {
    const p = new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPE,
        state
    });
    return `${AUTORIZE_URL}?${p.toString()}`;
}

// Troca o "code" devolvido pelo Discord por um access_token. Retorna null em falha.
async function trocarCodigo(code, redirectUri) {
    try {
        const body = new URLSearchParams({
            client_id: process.env.DISCORD_CLIENT_ID,
            client_secret: process.env.DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri
        });
        const r = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });
        if (!r.ok) return null;
        const j = await r.json().catch(() => null);
        return j && j.access_token ? j.access_token : null;
    } catch {
        return null;
    }
}

// Busca o perfil do dono do token. Retorna { id, username, email|null } ou null.
async function buscarUsuario(accessToken) {
    try {
        const r = await fetch(ME_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!r.ok) return null;
        const u = await r.json().catch(() => null);
        if (!u || !u.id) return null;
        return {
            id: String(u.id),
            username: u.global_name || u.username || `discord_${u.id}`,
            // Só confia no email se o Discord marcou como verificado.
            email: u.email && u.verified ? String(u.email).trim().toLowerCase() : null
        };
    } catch {
        return null;
    }
}

module.exports = { estaConfigurado, urlAutorizacao, trocarCodigo, buscarUsuario };
