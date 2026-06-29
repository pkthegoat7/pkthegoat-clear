/**
 * Carrega o token Discord (decifrado) de um usuário do painel, por nome.
 * Usa a service role key — mesmo Supabase/ENCRYPTION_KEY do painel.
 */

const { createClient } = require('@supabase/supabase-js');
const { decifrarToken } = require('./crypto');

let cliente = null;
function obterCliente() {
    if (cliente) return cliente;
    // trim defensivo: versões recentes do supabase-js rejeitam URL com espaço.
    const url = (process.env.SUPABASE_URL || '').trim();
    const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não definidos.');
    cliente = createClient(url, key, { auth: { persistSession: false } });
    return cliente;
}

async function carregarTokenPorNome(email, nome) {
    const sb = obterCliente();
    const { data, error } = await sb
        .from('painel_user_tokens')
        .select('nome, token_cifrado, iv, auth_tag')
        .eq('email', String(email || '').trim().toLowerCase())
        .eq('nome', nome)
        .maybeSingle();
    if (error) { console.error('[self-browser] query token erro:', error.message); return null; }
    if (!data) { console.error('[self-browser] token não encontrado p/', email, '/', nome); return null; }
    try {
        return decifrarToken({ token_cifrado: data.token_cifrado, iv: data.iv, auth_tag: data.auth_tag });
    } catch (e) {
        console.error('[self-browser] decifrar falhou:', e.message);
        return null;
    }
}

module.exports = { carregarTokenPorNome };
