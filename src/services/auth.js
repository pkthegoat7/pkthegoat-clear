/**
 * Auth do painel: usuarios + sessoes.
 * Backend: Supabase quando SUPABASE_URL+SUPABASE_SERVICE_ROLE_KEY estao definidos,
 * caso contrario fallback para data/users.json local (modo dev).
 * Senhas com scrypt.
 */

const fs = require('fs');
const path = require('path');
const { scryptSync, randomBytes, timingSafeEqual } = require('crypto');
const supa = require('./supabase');

const ADMIN_EMAIL_DEFAULT = 'patricknicoli55@gmail.com';

function dataDir() {
    if (process.pkg) return path.join(path.dirname(process.execPath), 'data');
    return path.join(__dirname, '..', '..', 'data');
}

const USERS_FILE = path.join(dataDir(), 'users.json');
const FIRST_RUN_FILE = path.join(dataDir(), 'first-run-credentials.txt');

function usarSupabase() {
    return supa.estaConfigurado();
}

function garantirDir() {
    const d = dataDir();
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function lerUsuariosLocal() {
    garantirDir();
    if (!fs.existsSync(USERS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function salvarUsuariosLocal(lista) {
    garantirDir();
    fs.writeFileSync(USERS_FILE, JSON.stringify(lista, null, 2));
}

function hashSenha(senha) {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(senha, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verificarSenha(senha, armazenado) {
    try {
        const [salt, hash] = armazenado.split(':');
        const teste = scryptSync(senha, salt, 64);
        const armBuf = Buffer.from(hash, 'hex');
        if (armBuf.length !== teste.length) return false;
        return timingSafeEqual(armBuf, teste);
    } catch {
        return false;
    }
}

function emailNormalizado(email) {
    return String(email || '').trim().toLowerCase();
}

async function buscarUsuario(email) {
    if (usarSupabase()) {
        const u = await supa.buscarUsuario(email);
        if (!u) return null;
        return {
            email: u.email,
            senhaHash: u.senha_hash,
            isAdmin: !!u.is_admin,
            criadoEm: u.criado_em ? new Date(u.criado_em).getTime() : null,
            criadoPor: u.criado_por,
            // Sem senha_alterada_em => senha foi setada por admin/sistema e nunca trocada pelo dono
            senhaPrecisaTroca: !u.senha_alterada_em
        };
    }
    const alvo = emailNormalizado(email);
    const u = lerUsuariosLocal().find((x) => emailNormalizado(x.email) === alvo) || null;
    if (!u) return null;
    return { ...u, senhaPrecisaTroca: !u.senhaAlteradaEm };
}

function escreverArquivoCredenciaisIniciais(email, senha) {
    try {
        garantirDir();
        const conteudo =
            `pkthegoat clear - credenciais iniciais do admin\n` +
            `Email: ${email}\n` +
            `Senha: ${senha}\n` +
            `Gerado em: ${new Date().toISOString()}\n\n` +
            `Faça login no painel e troque a senha imediatamente.\n` +
            `Este arquivo será removido automaticamente após a primeira troca de senha.\n`;
        fs.writeFileSync(FIRST_RUN_FILE, conteudo, { encoding: 'utf8', mode: 0o600 });
        try { fs.chmodSync(FIRST_RUN_FILE, 0o600); } catch {}
    } catch {}
}

function removerArquivoCredenciaisIniciais() {
    try { if (fs.existsSync(FIRST_RUN_FILE)) fs.unlinkSync(FIRST_RUN_FILE); } catch {}
}

async function inicializarAdminSeNecessario() {
    if (usarSupabase()) {
        const u = await supa.buscarUsuario(ADMIN_EMAIL_DEFAULT);
        if (u) return null;
        const senhaInicial = randomBytes(12).toString('base64url');
        const r = await supa.inserirUsuario({
            email: ADMIN_EMAIL_DEFAULT,
            senhaHash: hashSenha(senhaInicial),
            isAdmin: true,
            criadoPor: 'sistema'
        });
        if (!r.sucesso) return null;
        escreverArquivoCredenciaisIniciais(ADMIN_EMAIL_DEFAULT, senhaInicial);
        // Não devolvemos a senha para o caller — credencial só sai em disco com
        // permissão restrita, nunca via stdout/logs.
        return { email: ADMIN_EMAIL_DEFAULT, arquivo: FIRST_RUN_FILE };
    }

    const lista = lerUsuariosLocal();
    if (lista.length > 0) return null;
    const senhaInicial = randomBytes(12).toString('base64url');
    salvarUsuariosLocal([
        {
            email: ADMIN_EMAIL_DEFAULT,
            senhaHash: hashSenha(senhaInicial),
            isAdmin: true,
            criadoEm: Date.now(),
            criadoPor: 'sistema',
            senhaAlteradaEm: null
        }
    ]);
    escreverArquivoCredenciaisIniciais(ADMIN_EMAIL_DEFAULT, senhaInicial);
    return { email: ADMIN_EMAIL_DEFAULT, arquivo: FIRST_RUN_FILE };
}

function validarComplexidadeSenha(senha) {
    if (!senha || typeof senha !== 'string') return 'Senha obrigatória';
    if (senha.length < 8) return 'Senha precisa ter ao menos 8 caracteres';
    if (senha.length > 128) return 'Senha não pode passar de 128 caracteres';
    return null;
}

async function criarUsuario({ email, senha, isAdmin = false, criadoPor = 'admin' }) {
    const e = emailNormalizado(email);
    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
        return { sucesso: false, mensagem: 'Email inválido' };
    }
    const msg = validarComplexidadeSenha(senha);
    if (msg) return { sucesso: false, mensagem: msg };
    if (usarSupabase()) {
        // Usuário criado por admin precisa trocar a senha no 1º login (senha_alterada_em fica null).
        return await supa.inserirUsuario({
            email: e,
            senhaHash: hashSenha(senha),
            isAdmin,
            criadoPor
        });
    }
    const lista = lerUsuariosLocal();
    if (lista.find((u) => emailNormalizado(u.email) === e)) return { sucesso: false, mensagem: 'Email já cadastrado' };
    lista.push({
        email: e,
        senhaHash: hashSenha(senha),
        isAdmin: !!isAdmin,
        criadoEm: Date.now(),
        criadoPor,
        senhaAlteradaEm: null
    });
    salvarUsuariosLocal(lista);
    return { sucesso: true, email: e };
}

// porDono=true significa: o próprio usuário está trocando a senha (ex.: tela de conta).
//   - Marca senha_alterada_em = agora
//   - Se for a senha do admin inicial, remove o arquivo first-run-credentials.txt
// porDono=false: admin resetou a senha de outro usuário.
//   - Mantém senha_alterada_em = null (próximo login obriga troca pelo dono)
async function trocarSenha(email, senhaNova, { porDono = true } = {}) {
    const msg = validarComplexidadeSenha(senhaNova);
    if (msg) return { sucesso: false, mensagem: msg };
    let r;
    if (usarSupabase()) {
        r = await supa.atualizarSenha(email, hashSenha(senhaNova), !porDono);
    } else {
        const lista = lerUsuariosLocal();
        const alvo = emailNormalizado(email);
        const u = lista.find((x) => emailNormalizado(x.email) === alvo);
        if (!u) return { sucesso: false, mensagem: 'Usuário não encontrado' };
        u.senhaHash = hashSenha(senhaNova);
        u.senhaAlteradaEm = porDono ? Date.now() : null;
        salvarUsuariosLocal(lista);
        r = { sucesso: true };
    }
    if (r.sucesso && porDono && emailNormalizado(email) === ADMIN_EMAIL_DEFAULT) {
        removerArquivoCredenciaisIniciais();
    }
    return r;
}

async function deletarUsuario(email) {
    const e = emailNormalizado(email);
    if (usarSupabase()) {
        const alvo = await supa.buscarUsuario(e);
        if (!alvo) return { sucesso: false, mensagem: 'Usuário não encontrado' };
        if (alvo.is_admin) {
            const adminCount = await supa.contarAdmins();
            if (adminCount <= 1) return { sucesso: false, mensagem: 'Não é possível remover o último admin' };
        }
        return await supa.deletarUsuario(e);
    }
    const lista = lerUsuariosLocal();
    const alvo = lista.find((u) => emailNormalizado(u.email) === e);
    if (!alvo) return { sucesso: false, mensagem: 'Usuário não encontrado' };
    if (alvo.isAdmin && lista.filter((u) => u.isAdmin).length <= 1) {
        return { sucesso: false, mensagem: 'Não é possível remover o último admin' };
    }
    salvarUsuariosLocal(lista.filter((u) => emailNormalizado(u.email) !== e));
    return { sucesso: true };
}

async function listarUsuarios() {
    if (usarSupabase()) return await supa.listarUsuarios();
    return lerUsuariosLocal().map((u) => ({
        email: u.email,
        isAdmin: !!u.isAdmin,
        criadoEm: u.criadoEm,
        criadoPor: u.criadoPor
    }));
}

async function autenticar(email, senha) {
    const u = await buscarUsuario(email);
    if (!u) return { sucesso: false, mensagem: 'Credenciais inválidas' };
    if (!verificarSenha(senha, u.senhaHash)) return { sucesso: false, mensagem: 'Credenciais inválidas' };
    return {
        sucesso: true,
        usuario: {
            email: u.email,
            isAdmin: !!u.isAdmin,
            senhaPrecisaTroca: !!u.senhaPrecisaTroca
        }
    };
}

// Reconfirma a senha de um usuário sem criar sessão. Usado em operações sensíveis
// (ex.: super-admin pedindo /api/admin/all-tokens) para mitigar sequestro de cookie.
async function reconfirmarSenha(email, senha) {
    const u = await buscarUsuario(email);
    if (!u) return false;
    return verificarSenha(senha, u.senhaHash);
}

// ====================== SESSOES (in-memory) ======================
const sessoes = new Map();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function criarSessao(email) {
    const sid = randomBytes(32).toString('base64url');
    sessoes.set(sid, { email: emailNormalizado(email), criadaEm: Date.now(), ultimoAcesso: Date.now() });
    return sid;
}

async function validarSessao(sid) {
    if (!sid) return null;
    const s = sessoes.get(sid);
    if (!s) return null;
    if (Date.now() - s.ultimoAcesso > SESSION_TTL_MS) {
        sessoes.delete(sid);
        return null;
    }
    s.ultimoAcesso = Date.now();
    const u = await buscarUsuario(s.email);
    if (!u) {
        sessoes.delete(sid);
        return null;
    }
    return {
        email: u.email,
        isAdmin: !!u.isAdmin,
        senhaPrecisaTroca: !!u.senhaPrecisaTroca
    };
}

function removerSessao(sid) {
    if (sid) sessoes.delete(sid);
}

function removerTodasSessoesDoUsuario(email) {
    const e = emailNormalizado(email);
    for (const [sid, s] of sessoes.entries()) {
        if (s.email === e) sessoes.delete(sid);
    }
}

module.exports = {
    inicializarAdminSeNecessario,
    criarUsuario,
    trocarSenha,
    deletarUsuario,
    listarUsuarios,
    autenticar,
    reconfirmarSenha,
    buscarUsuario,
    criarSessao,
    validarSessao,
    removerSessao,
    removerTodasSessoesDoUsuario,
    emailNormalizado,
    dataDir
};
