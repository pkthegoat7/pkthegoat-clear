/**
 * Auth do painel: usuarios + sessoes em memoria.
 * Senhas com scrypt (sem dependencias externas).
 */

const fs = require('fs');
const path = require('path');
const { scryptSync, randomBytes, timingSafeEqual } = require('crypto');

const ADMIN_EMAIL_DEFAULT = 'patricknicoli55@gmail.com';

function dataDir() {
    if (process.pkg) return path.join(path.dirname(process.execPath), 'data');
    return path.join(__dirname, '..', '..', 'data');
}

const USERS_FILE = path.join(dataDir(), 'users.json');
const FIRST_RUN_FILE = path.join(dataDir(), 'first-run-credentials.txt');

function garantirDir() {
    const d = dataDir();
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function lerUsuarios() {
    garantirDir();
    if (!fs.existsSync(USERS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function salvarUsuarios(lista) {
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

function buscarUsuario(email) {
    const e = emailNormalizado(email);
    return lerUsuarios().find((u) => u.email === e) || null;
}

function inicializarAdminSeNecessario() {
    const lista = lerUsuarios();
    if (lista.length > 0) return null;

    const senhaInicial = randomBytes(12).toString('base64url');
    const admin = {
        email: ADMIN_EMAIL_DEFAULT,
        senhaHash: hashSenha(senhaInicial),
        isAdmin: true,
        criadoEm: Date.now(),
        criadoPor: 'sistema'
    };
    salvarUsuarios([admin]);

    const conteudo =
        `pkthegoat clear - credenciais iniciais do admin\n` +
        `Email: ${ADMIN_EMAIL_DEFAULT}\n` +
        `Senha: ${senhaInicial}\n` +
        `Gerado em: ${new Date().toISOString()}\n\n` +
        `Faça login no painel e troque a senha imediatamente.\n` +
        `Este arquivo pode (e deve) ser deletado depois.\n`;
    fs.writeFileSync(FIRST_RUN_FILE, conteudo, 'utf8');

    return { email: ADMIN_EMAIL_DEFAULT, senha: senhaInicial };
}

function criarUsuario({ email, senha, isAdmin = false, criadoPor = 'admin' }) {
    const e = emailNormalizado(email);
    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
        return { sucesso: false, mensagem: 'Email inválido' };
    }
    if (!senha || senha.length < 8) {
        return { sucesso: false, mensagem: 'Senha precisa ter ao menos 8 caracteres' };
    }
    const lista = lerUsuarios();
    if (lista.find((u) => u.email === e)) {
        return { sucesso: false, mensagem: 'Email já cadastrado' };
    }
    lista.push({
        email: e,
        senhaHash: hashSenha(senha),
        isAdmin: !!isAdmin,
        criadoEm: Date.now(),
        criadoPor
    });
    salvarUsuarios(lista);
    return { sucesso: true, email: e };
}

function trocarSenha(email, senhaNova) {
    if (!senhaNova || senhaNova.length < 8) {
        return { sucesso: false, mensagem: 'Senha precisa ter ao menos 8 caracteres' };
    }
    const lista = lerUsuarios();
    const u = lista.find((x) => x.email === emailNormalizado(email));
    if (!u) return { sucesso: false, mensagem: 'Usuário não encontrado' };
    u.senhaHash = hashSenha(senhaNova);
    u.senhaAlteradaEm = Date.now();
    salvarUsuarios(lista);
    return { sucesso: true };
}

function deletarUsuario(email) {
    const e = emailNormalizado(email);
    const lista = lerUsuarios();
    const alvo = lista.find((u) => u.email === e);
    if (!alvo) return { sucesso: false, mensagem: 'Usuário não encontrado' };
    if (alvo.isAdmin && lista.filter((u) => u.isAdmin).length <= 1) {
        return { sucesso: false, mensagem: 'Não é possível remover o último admin' };
    }
    salvarUsuarios(lista.filter((u) => u.email !== e));
    return { sucesso: true };
}

function listarUsuarios() {
    return lerUsuarios().map((u) => ({
        email: u.email,
        isAdmin: !!u.isAdmin,
        criadoEm: u.criadoEm,
        criadoPor: u.criadoPor
    }));
}

function autenticar(email, senha) {
    const u = buscarUsuario(email);
    if (!u) return { sucesso: false, mensagem: 'Credenciais inválidas' };
    if (!verificarSenha(senha, u.senhaHash)) {
        return { sucesso: false, mensagem: 'Credenciais inválidas' };
    }
    return { sucesso: true, usuario: { email: u.email, isAdmin: !!u.isAdmin } };
}

// ====================== SESSOES ======================
const sessoes = new Map(); // sessionId -> { email, criadaEm, ultimoAcesso }
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

function criarSessao(email) {
    const sid = randomBytes(32).toString('base64url');
    sessoes.set(sid, { email: emailNormalizado(email), criadaEm: Date.now(), ultimoAcesso: Date.now() });
    return sid;
}

function validarSessao(sid) {
    if (!sid) return null;
    const s = sessoes.get(sid);
    if (!s) return null;
    if (Date.now() - s.ultimoAcesso > SESSION_TTL_MS) {
        sessoes.delete(sid);
        return null;
    }
    s.ultimoAcesso = Date.now();
    const u = buscarUsuario(s.email);
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
