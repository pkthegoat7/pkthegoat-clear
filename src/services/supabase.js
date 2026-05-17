/**
 * Cliente Supabase + data access para o painel pkthegoat.
 *
 * Requer envs:
 *   SUPABASE_URL                    URL do projeto (https://xxx.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY       chave service_role (NUNCA expor no frontend)
 *
 * RLS está habilitado mas o backend usa service_role, que bypassa.
 * O isolamento por usuário é garantido pelo app via filtragem em todas as queries.
 */

const { createClient } = require('@supabase/supabase-js');
const { cifrarToken, decifrarToken } = require('./crypto');

let cliente = null;
let configurado = false;

function obterCliente() {
    if (cliente) return cliente;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        configurado = false;
        return null;
    }
    cliente = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
        // Não usamos realtime; reduz dependência de WebSocket global no Node.
        realtime: { params: { eventsPerSecond: 0 } },
        db: { schema: 'public' }
    });
    configurado = true;
    return cliente;
}

function estaConfigurado() {
    if (cliente) return true;
    obterCliente();
    return configurado;
}

function normalizarEmail(email) {
    return String(email || '').trim().toLowerCase();
}

// ====================== USERS ======================
async function buscarUsuario(email) {
    const sb = obterCliente();
    if (!sb) return null;
    const { data, error } = await sb
        .from('painel_users')
        .select('*')
        .eq('email', normalizarEmail(email))
        .maybeSingle();
    if (error) {
        console.error('Supabase buscarUsuario:', error.message);
        return null;
    }
    return data;
}

async function listarUsuarios() {
    const sb = obterCliente();
    if (!sb) return [];
    const { data, error } = await sb
        .from('painel_users')
        .select('email, is_admin, criado_em, criado_por')
        .order('criado_em', { ascending: true });
    if (error) {
        console.error('Supabase listarUsuarios:', error.message);
        return [];
    }
    return data.map((u) => ({
        email: u.email,
        isAdmin: !!u.is_admin,
        criadoEm: u.criado_em ? new Date(u.criado_em).getTime() : null,
        criadoPor: u.criado_por
    }));
}

async function inserirUsuario({ email, senhaHash, isAdmin, criadoPor }) {
    const sb = obterCliente();
    if (!sb) return { sucesso: false, mensagem: 'Supabase não configurado' };
    const { error } = await sb.from('painel_users').insert({
        email: normalizarEmail(email),
        senha_hash: senhaHash,
        is_admin: !!isAdmin,
        criado_por: criadoPor || null
    });
    if (error) {
        if (error.code === '23505') return { sucesso: false, mensagem: 'Email já cadastrado' };
        return { sucesso: false, mensagem: error.message };
    }
    return { sucesso: true };
}

async function atualizarSenha(email, senhaHash) {
    const sb = obterCliente();
    if (!sb) return { sucesso: false, mensagem: 'Supabase não configurado' };
    const { data, error } = await sb
        .from('painel_users')
        .update({ senha_hash: senhaHash, senha_alterada_em: new Date().toISOString() })
        .eq('email', normalizarEmail(email))
        .select();
    if (error) return { sucesso: false, mensagem: error.message };
    if (!data || data.length === 0) return { sucesso: false, mensagem: 'Usuário não encontrado' };
    return { sucesso: true };
}

async function deletarUsuario(email) {
    const sb = obterCliente();
    if (!sb) return { sucesso: false, mensagem: 'Supabase não configurado' };
    const { data, error } = await sb
        .from('painel_users')
        .delete()
        .eq('email', normalizarEmail(email))
        .select();
    if (error) return { sucesso: false, mensagem: error.message };
    if (!data || data.length === 0) return { sucesso: false, mensagem: 'Usuário não encontrado' };
    return { sucesso: true };
}

async function contarAdmins() {
    const sb = obterCliente();
    if (!sb) return 0;
    const { count, error } = await sb
        .from('painel_users')
        .select('email', { count: 'exact', head: true })
        .eq('is_admin', true);
    if (error) return 0;
    return count || 0;
}

// ====================== TOKENS DISCORD (por usuário, cifrados) ======================
async function listarTokensUsuario(email) {
    const sb = obterCliente();
    if (!sb) return [];
    const { data, error } = await sb
        .from('painel_user_tokens')
        .select('nome, criado_em')
        .eq('email', normalizarEmail(email))
        .order('criado_em', { ascending: true });
    if (error) {
        console.error('Supabase listarTokens:', error.message);
        return [];
    }
    return data.map((t) => ({ nome: t.nome }));
}

async function listarTokensComValor(email) {
    const sb = obterCliente();
    if (!sb) return [];
    const { data, error } = await sb
        .from('painel_user_tokens')
        .select('*')
        .eq('email', normalizarEmail(email));
    if (error) {
        console.error('Supabase listarTokensComValor:', error.message);
        return [];
    }
    return data.map((row) => ({
        nome: row.nome,
        token: decifrarToken({ token_cifrado: row.token_cifrado, iv: row.iv, auth_tag: row.auth_tag })
    }));
}

async function buscarTokenPorNome(email, nome) {
    const tokens = await listarTokensComValor(email);
    return tokens.find((t) => t.nome === nome) || null;
}

async function adicionarToken(email, nome, token) {
    const sb = obterCliente();
    if (!sb) return { sucesso: false, mensagem: 'Supabase não configurado' };
    const cifrado = cifrarToken(token);
    const { error } = await sb.from('painel_user_tokens').insert({
        email: normalizarEmail(email),
        nome,
        token_cifrado: cifrado.token_cifrado,
        iv: cifrado.iv,
        auth_tag: cifrado.auth_tag
    });
    if (error) {
        if (error.code === '23505') return { sucesso: false, mensagem: 'Já existe token com esse nome' };
        if (error.code === '23503') return { sucesso: false, mensagem: 'Usuário não cadastrado' };
        return { sucesso: false, mensagem: error.message };
    }
    return { sucesso: true };
}

async function removerToken(email, nome) {
    const sb = obterCliente();
    if (!sb) return { sucesso: false, mensagem: 'Supabase não configurado' };
    const { data, error } = await sb
        .from('painel_user_tokens')
        .delete()
        .eq('email', normalizarEmail(email))
        .eq('nome', nome)
        .select();
    if (error) return { sucesso: false, mensagem: error.message };
    if (!data || data.length === 0) return { sucesso: false, mensagem: 'Token não encontrada' };
    return { sucesso: true };
}

async function deletarTodosTokensDoUsuario(email) {
    const sb = obterCliente();
    if (!sb) return;
    await sb.from('painel_user_tokens').delete().eq('email', normalizarEmail(email));
}

module.exports = {
    estaConfigurado,
    buscarUsuario,
    listarUsuarios,
    inserirUsuario,
    atualizarSenha,
    deletarUsuario,
    contarAdmins,
    listarTokensUsuario,
    listarTokensComValor,
    buscarTokenPorNome,
    adicionarToken,
    removerToken,
    deletarTodosTokensDoUsuario
};
