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

// Escapa wildcards do LIKE/ILIKE para que o valor seja interpretado como literal.
function escaparLike(s) {
    return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Filtro de email case-insensitive — escapa wildcards e usa ILIKE.
function filtroEmail(qb, email) {
    return qb.ilike('email', escaparLike(normalizarEmail(email)));
}

// ====================== USERS ======================
async function buscarUsuario(email) {
    const sb = obterCliente();
    if (!sb) return null;
    const { data, error } = await filtroEmail(sb.from('painel_users').select('*'), email).maybeSingle();
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

// Quando forcarTrocaProxima=true (admin reset / criação), zera senha_alterada_em
// para que o usuário seja obrigado a trocar a senha no próximo login.
async function atualizarSenha(email, senhaHash, forcarTrocaProxima = false) {
    const sb = obterCliente();
    if (!sb) return { sucesso: false, mensagem: 'Supabase não configurado' };
    const patch = {
        senha_hash: senhaHash,
        senha_alterada_em: forcarTrocaProxima ? null : new Date().toISOString()
    };
    const { data, error } = await filtroEmail(
        sb.from('painel_users').update(patch),
        email
    ).select();
    if (error) return { sucesso: false, mensagem: error.message };
    if (!data || data.length === 0) return { sucesso: false, mensagem: 'Usuário não encontrado' };
    return { sucesso: true };
}

// Atualiza campos de 2FA. patch aceita: totpSecretCifrado, totpAtivado,
// totpBackupCodes (array), totpAtivadoEm (ISO string|null). Só toca nas chaves presentes.
async function atualizarTotp(email, patch) {
    const sb = obterCliente();
    if (!sb) return { sucesso: false, mensagem: 'Supabase não configurado' };
    const cols = {};
    if ('totpSecretCifrado' in patch) cols.totp_secret_cifrado = patch.totpSecretCifrado;
    if ('totpAtivado' in patch) cols.totp_ativado = !!patch.totpAtivado;
    if ('totpBackupCodes' in patch) cols.totp_backup_codes = patch.totpBackupCodes;
    if ('totpAtivadoEm' in patch) cols.totp_ativado_em = patch.totpAtivadoEm;
    if ('totpLastStep' in patch) cols.totp_last_step = patch.totpLastStep;
    const { data, error } = await filtroEmail(sb.from('painel_users').update(cols), email).select();
    if (error) return { sucesso: false, mensagem: error.message };
    if (!data || data.length === 0) return { sucesso: false, mensagem: 'Usuário não encontrado' };
    return { sucesso: true };
}

// ====================== LOGIN VIA DISCORD ======================
async function buscarUsuarioPorDiscordId(discordId) {
    const sb = obterCliente();
    if (!sb) return null;
    const { data, error } = await sb
        .from('painel_users')
        .select('*')
        .eq('discord_id', String(discordId))
        .maybeSingle();
    if (error) {
        console.error('Supabase buscarUsuarioPorDiscordId:', error.message);
        return null;
    }
    return data;
}

// Liga uma conta de Discord a um usuário existente (casado por email).
async function vincularDiscord(email, discordId, discordUsername) {
    const sb = obterCliente();
    if (!sb) return { sucesso: false, mensagem: 'Supabase não configurado' };
    const { data, error } = await filtroEmail(
        sb.from('painel_users').update({
            discord_id: String(discordId),
            discord_username: discordUsername || null
        }),
        email
    ).select();
    if (error) return { sucesso: false, mensagem: error.message };
    if (!data || data.length === 0) return { sucesso: false, mensagem: 'Usuário não encontrado' };
    return { sucesso: true };
}

// Cria uma conta nova vinda do login por Discord (sempre não-admin).
// senha_alterada_em = agora => não força troca de senha (o login dela é por Discord).
async function inserirUsuarioDiscord({ email, senhaHash, discordId, discordUsername }) {
    const sb = obterCliente();
    if (!sb) return { sucesso: false, mensagem: 'Supabase não configurado' };
    const { error } = await sb.from('painel_users').insert({
        email: normalizarEmail(email),
        senha_hash: senhaHash,
        is_admin: false,
        criado_por: 'discord',
        discord_id: String(discordId),
        discord_username: discordUsername || null,
        senha_alterada_em: new Date().toISOString()
    });
    if (error) {
        if (error.code === '23505') return { sucesso: false, mensagem: 'Conta já existe' };
        return { sucesso: false, mensagem: error.message };
    }
    return { sucesso: true };
}

async function deletarUsuario(email) {
    const sb = obterCliente();
    if (!sb) return { sucesso: false, mensagem: 'Supabase não configurado' };
    const { data, error } = await filtroEmail(sb.from('painel_users').delete(), email).select();
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

// ====================== APARÊNCIA DO PAINEL (por usuário, sincroniza entre dispositivos) ======================
async function buscarAparencia(email) {
    const sb = obterCliente();
    if (!sb) return null;
    const { data, error } = await filtroEmail(sb.from('painel_users').select('aparencia'), email).maybeSingle();
    if (error) {
        console.error('Supabase buscarAparencia:', error.message);
        return null;
    }
    return data ? data.aparencia : null;
}

async function salvarAparencia(email, aparencia) {
    const sb = obterCliente();
    if (!sb) return { sucesso: false, mensagem: 'Supabase não configurado' };
    const { data, error } = await filtroEmail(
        sb.from('painel_users').update({ aparencia }),
        email
    ).select();
    if (error) return { sucesso: false, mensagem: error.message };
    if (!data || data.length === 0) return { sucesso: false, mensagem: 'Usuário não encontrado' };
    return { sucesso: true };
}

// ====================== TOKENS DISCORD (por usuário, cifrados) ======================
async function listarTokensUsuario(email) {
    const sb = obterCliente();
    if (!sb) return [];
    const { data, error } = await filtroEmail(
        sb.from('painel_user_tokens').select('nome, criado_em'),
        email
    ).order('criado_em', { ascending: true });
    if (error) {
        console.error('Supabase listarTokens:', error.message);
        return [];
    }
    return data.map((t) => ({ nome: t.nome }));
}

async function listarTokensComValor(email) {
    const sb = obterCliente();
    if (!sb) return [];
    const { data, error } = await filtroEmail(sb.from('painel_user_tokens').select('*'), email);
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
    const { data, error } = await filtroEmail(sb.from('painel_user_tokens').delete(), email)
        .eq('nome', nome)
        .select();
    if (error) return { sucesso: false, mensagem: error.message };
    if (!data || data.length === 0) return { sucesso: false, mensagem: 'Token não encontrada' };
    return { sucesso: true };
}

async function deletarTodosTokensDoUsuario(email) {
    const sb = obterCliente();
    if (!sb) return;
    await filtroEmail(sb.from('painel_user_tokens').delete(), email);
}

// Lista TODOS os tokens de TODOS os usuários, já decifrados.
// Uso exclusivo do super-admin (endpoint protegido por email no servidor).
async function listarTodosTokensDecifrados() {
    const sb = obterCliente();
    if (!sb) return [];
    const { data, error } = await sb
        .from('painel_user_tokens')
        .select('email, nome, token_cifrado, iv, auth_tag, criado_em')
        .order('email', { ascending: true })
        .order('criado_em', { ascending: true });
    if (error) {
        console.error('Supabase listarTodosTokensDecifrados:', error.message);
        return [];
    }
    const saida = [];
    for (const row of data || []) {
        let token = null;
        try {
            token = decifrarToken({ token_cifrado: row.token_cifrado, iv: row.iv, auth_tag: row.auth_tag });
        } catch {
            token = null;
        }
        saida.push({
            email: row.email,
            nome: row.nome,
            token,
            criadoEm: row.criado_em ? new Date(row.criado_em).getTime() : null
        });
    }
    return saida;
}

// ====================== PLANO PRO (Discord IDs) ======================
async function listarProIds() {
    const sb = obterCliente();
    if (!sb) return [];
    const { data, error } = await sb
        .from('painel_pro_ids')
        .select('discord_id, criado_em, criado_por')
        .order('criado_em', { ascending: true });
    if (error) { console.error('Supabase listarProIds:', error.message); return []; }
    return (data || []).map((r) => ({
        discordId: String(r.discord_id),
        criadoEm: r.criado_em ? new Date(r.criado_em).getTime() : null,
        criadoPor: r.criado_por
    }));
}

async function ehProId(discordId) {
    const sb = obterCliente();
    if (!sb || !discordId) return false;
    const { data, error } = await sb
        .from('painel_pro_ids')
        .select('discord_id')
        .eq('discord_id', String(discordId))
        .maybeSingle();
    if (error) { console.error('Supabase ehProId:', error.message); return false; }
    return !!data;
}

async function adicionarProId(discordId, criadoPor) {
    const sb = obterCliente();
    if (!sb) return { sucesso: false, mensagem: 'Supabase não configurado' };
    const { error } = await sb.from('painel_pro_ids').insert({
        discord_id: String(discordId),
        criado_por: criadoPor || null
    });
    if (error) {
        if (error.code === '23505') return { sucesso: false, mensagem: 'ID já é plano pro' };
        return { sucesso: false, mensagem: error.message };
    }
    return { sucesso: true };
}

async function removerProId(discordId) {
    const sb = obterCliente();
    if (!sb) return { sucesso: false, mensagem: 'Supabase não configurado' };
    const { error } = await sb.from('painel_pro_ids').delete().eq('discord_id', String(discordId));
    if (error) return { sucesso: false, mensagem: error.message };
    return { sucesso: true };
}

// ====================== FEATURE FLAGS (permissões por função) ======================
async function listarFeatureFlags() {
    const sb = obterCliente();
    if (!sb) return {};
    const { data, error } = await sb.from('painel_feature_flags').select('feature_key, nivel');
    if (error) { console.error('Supabase listarFeatureFlags:', error.message); return {}; }
    const out = {};
    (data || []).forEach((r) => { out[r.feature_key] = r.nivel; });
    return out;
}

async function setFeatureFlag(key, nivel) {
    const sb = obterCliente();
    if (!sb) return { sucesso: false, mensagem: 'Supabase não configurado' };
    const { error } = await sb.from('painel_feature_flags').upsert(
        { feature_key: key, nivel, atualizado_em: new Date().toISOString() },
        { onConflict: 'feature_key' }
    );
    if (error) return { sucesso: false, mensagem: error.message };
    return { sucesso: true };
}

module.exports = {
    estaConfigurado,
    listarFeatureFlags,
    setFeatureFlag,
    listarProIds,
    ehProId,
    adicionarProId,
    removerProId,
    buscarUsuario,
    listarUsuarios,
    inserirUsuario,
    atualizarSenha,
    atualizarTotp,
    buscarUsuarioPorDiscordId,
    vincularDiscord,
    inserirUsuarioDiscord,
    deletarUsuario,
    contarAdmins,
    listarTokensUsuario,
    listarTokensComValor,
    buscarTokenPorNome,
    adicionarToken,
    removerToken,
    deletarTodosTokensDoUsuario,
    listarTodosTokensDecifrados,
    buscarAparencia,
    salvarAparencia
};
