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
            criadoPor: u.criado_por
        };
    }
    const alvo = emailNormalizado(email);
    return lerUsuariosLocal().find((u) => emailNormalizado(u.email) === alvo) || null;
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
        try {
            garantirDir();
            fs.writeFileSync(
                FIRST_RUN_FILE,
                `pkthegoat clear - credenciais iniciais do admin\nEmail: ${ADMIN_EMAIL_DEFAULT}\nSenha: ${senhaInicial}\nGerado em: ${new Date().toISOString()}\n\nFaça login no painel e troque a senha imediatamente.\n`,
                'utf8'
            );
        } catch {}
        return { email: ADMIN_EMAIL_DEFAULT, senha: senhaInicial };
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
            criadoPor: 'sistema'
        }
    ]);
    fs.writeFileSync(
        FIRST_RUN_FILE,
        `pkthegoat clear - credenciais iniciais do admin\nEmail: ${ADMIN_EMAIL_DEFAULT}\nSenha: ${senhaInicial}\nGerado em: ${new Date().toISOString()}\n\nFaça login no painel e troque a senha imediatamente.\n`,
        'utf8'
    );
    return { email: ADMIN_EMAIL_DEFAULT, senha: senhaInicial };
}

async function criarUsuario({ email, senha, isAdmin = false, criadoPor = 'admin' }) {
    const e = emailNormalizado(email);
    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
        return { sucesso: false, mensagem: 'Email inválido' };
    }
    if (!senha || senha.length < 8) {
        return { sucesso: false, mensagem: 'Senha precisa ter ao menos 8 caracteres' };
    }
    if (usarSupabase()) {
        return await supa.inserirUsuario({
            email: e,
            senhaHash: hashSenha(senha),
            isAdmin,
            criadoPor
        });
    }
    const lista = lerUsuariosLocal();
    if (lista.find((u) => emailNormalizado(u.email) === e)) return { sucesso: false, mensagem: 'Email já cadastrado' };
    lista.push({ email: e, senhaHash: hashSenha(senha), isAdmin: !!isAdmin, criadoEm: Date.now(), criadoPor });
    salvarUsuariosLocal(lista);
    return { sucesso: true, email: e };
}

async function trocarSenha(email, senhaNova) {
    if (!senhaNova || senhaNova.length < 8) {
        return { sucesso: false, mensagem: 'Senha precisa ter ao menos 8 caracteres' };
    }
    if (usarSupabase()) {
        return await supa.atualizarSenha(email, hashSenha(senhaNova));
    }
    const lista = lerUsuariosLocal();
    const alvo = emailNormalizado(email);
    const u = lista.find((x) => emailNormalizado(x.email) === alvo);
    if (!u) return { sucesso: false, mensagem: 'Usuário não encontrado' };
    u.senhaHash = hashSenha(senhaNova);
    u.senhaAlteradaEm = Date.now();
    salvarUsuariosLocal(lista);
    return { sucesso: true };
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
    return { sucesso: true, usuario: { email: u.email, isAdmin: !!u.isAdmin } };
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
    return { email: u.email, isAdmin: !!u.isAdmin };
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
    buscarUsuario,
    criarSessao,
    validarSessao,
    removerSessao,
    removerTodasSessoesDoUsuario,
    emailNormalizado,
    dataDir
};
