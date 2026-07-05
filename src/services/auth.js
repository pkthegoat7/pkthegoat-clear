/**
 * Auth do painel: usuarios + sessoes.
 * Backend: Supabase quando SUPABASE_URL+SUPABASE_SERVICE_ROLE_KEY estao definidos,
 * caso contrario fallback para data/users.json local (modo dev).
 * Senhas com scrypt.
 */

const fs = require('fs');
const path = require('path');
const { scryptSync, randomBytes, timingSafeEqual, createHash } = require('crypto');
const supa = require('./supabase');
const totp = require('./totp');
const cripto = require('./crypto');

const ADMIN_EMAIL_DEFAULT = 'patricknicoli55@gmail.com';
// Discord ID do super-admin. Quando esse Discord loga, ele é ligado à conta admin
// acima (a mesma do login por email/senha+2FA, que segue valendo como acesso reserva).
const SUPERADMIN_DISCORD_ID = String(process.env.SUPERADMIN_DISCORD_ID || '').trim();

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

const PRO_IDS_FILE = path.join(dataDir(), 'pro-ids.json');
function lerProIdsLocal() {
    garantirDir();
    if (!fs.existsSync(PRO_IDS_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(PRO_IDS_FILE, 'utf8')); } catch { return []; }
}
function salvarProIdsLocal(lista) {
    garantirDir();
    fs.writeFileSync(PRO_IDS_FILE, JSON.stringify(lista, null, 2));
}

const FEATURE_FLAGS_FILE = path.join(dataDir(), 'feature-flags.json');
function lerFeatureFlagsLocal() {
    garantirDir();
    if (!fs.existsSync(FEATURE_FLAGS_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(FEATURE_FLAGS_FILE, 'utf8')); } catch { return {}; }
}
function salvarFeatureFlagsLocal(obj) {
    garantirDir();
    fs.writeFileSync(FEATURE_FLAGS_FILE, JSON.stringify(obj, null, 2));
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
            senhaPrecisaTroca: !u.senha_alterada_em,
            totpAtivado: !!u.totp_ativado,
            totpSecretCifrado: u.totp_secret_cifrado || null,
            backupCodes: Array.isArray(u.totp_backup_codes) ? u.totp_backup_codes : [],
            totpLastStep: u.totp_last_step != null ? Number(u.totp_last_step) : 0,
            // discord_id exposto aqui para a checagem de plano pro reaproveitar o
            // mesmo fetch (evita uma 2ª ida ao Supabase só pra descobrir o Discord).
            discordId: u.discord_id || null,
            precisa2fa: emailNormalizado(u.email) === ADMIN_EMAIL_DEFAULT && !u.totp_ativado
        };
    }
    const alvo = emailNormalizado(email);
    const u = lerUsuariosLocal().find((x) => emailNormalizado(x.email) === alvo) || null;
    if (!u) return null;
    return {
        ...u,
        senhaPrecisaTroca: !u.senhaAlteradaEm,
        totpAtivado: !!u.totpAtivado,
        totpSecretCifrado: u.totpSecretCifrado || null,
        backupCodes: Array.isArray(u.totpBackupCodes) ? u.totpBackupCodes : [],
        // NOTE: modo local (sem Supabase) não tem caminho de escrita de 2FA (atualizarTotp só existe no supabase.js);
        // estes campos são leitura morta em dev. 2FA é efetivamente Supabase-only.
        totpLastStep: u.totpLastStep || 0,
        precisa2fa: emailNormalizado(u.email) === ADMIN_EMAIL_DEFAULT && !u.totpAtivado
    };
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

// Login/registro via Discord. Modo atual: "qualquer conta do Discord pode entrar".
// Regras, em ordem:
//   1. discord_id já vinculado a uma conta  -> loga nela.
//   2. discordId é o do super-admin (env)   -> liga à conta admin padrão e loga nela.
//   3. email (verificado) casa com conta existente -> liga o Discord a ela e loga.
//   4. nenhum dos acima -> cria conta nova, não-admin, com espaço isolado.
// Retorna { sucesso, email } ou { sucesso:false, mensagem }.
async function loginOuCriarViaDiscord({ id, username, email }) {
    const discordId = String(id || '').trim();
    if (!discordId) return { sucesso: false, mensagem: 'Perfil do Discord inválido' };
    const emailVerificado = email ? emailNormalizado(email) : null;
    const ehSuper = SUPERADMIN_DISCORD_ID && discordId === SUPERADMIN_DISCORD_ID;

    if (usarSupabase()) {
        const jaVinculado = await supa.buscarUsuarioPorDiscordId(discordId);
        if (jaVinculado) return { sucesso: true, email: jaVinculado.email };

        if (ehSuper) {
            await supa.vincularDiscord(ADMIN_EMAIL_DEFAULT, discordId, username);
            return { sucesso: true, email: ADMIN_EMAIL_DEFAULT };
        }

        if (emailVerificado) {
            const porEmail = await supa.buscarUsuario(emailVerificado);
            if (porEmail) {
                await supa.vincularDiscord(porEmail.email, discordId, username);
                return { sucesso: true, email: porEmail.email };
            }
        }

        const emailFinal = emailVerificado || `discord_${discordId}@discord.local`;
        const senhaAleatoria = randomBytes(24).toString('base64url');
        const r = await supa.inserirUsuarioDiscord({
            email: emailFinal,
            senhaHash: hashSenha(senhaAleatoria),
            discordId,
            discordUsername: username
        });
        if (!r.sucesso) return { sucesso: false, mensagem: r.mensagem || 'Falha ao criar conta' };
        return { sucesso: true, email: emailNormalizado(emailFinal) };
    }

    // ===== modo local (sem Supabase, dev) =====
    const lista = lerUsuariosLocal();
    let u = lista.find((x) => String(x.discordId || '') === discordId);
    if (!u && ehSuper) u = lista.find((x) => emailNormalizado(x.email) === ADMIN_EMAIL_DEFAULT);
    if (!u && emailVerificado) u = lista.find((x) => emailNormalizado(x.email) === emailVerificado);
    if (u) {
        u.discordId = discordId;
        u.discordUsername = username;
        salvarUsuariosLocal(lista);
        return { sucesso: true, email: u.email };
    }
    const emailFinal = emailVerificado || `discord_${discordId}@discord.local`;
    const senhaAleatoria = randomBytes(24).toString('base64url');
    lista.push({
        email: emailNormalizado(emailFinal),
        senhaHash: hashSenha(senhaAleatoria),
        isAdmin: false,
        criadoEm: Date.now(),
        criadoPor: 'discord',
        senhaAlteradaEm: Date.now(),
        discordId,
        discordUsername: username
    });
    salvarUsuariosLocal(lista);
    return { sucesso: true, email: emailNormalizado(emailFinal) };
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
// Cache curto do usuário POR SESSÃO. Antes, validarSessao batia no Supabase em
// CADA request (e o /me ainda repetia o buscarUsuario 2-3x), somando ~4 idas em
// série = a maior fatia do response time. Com o cache, a maioria dos requests não
// toca o Supabase. Mudanças de senha/2FA refletem em <= TTL ou na hora via
// invalidarCacheUsuario (chamado nos handlers de escrita).
const USER_CACHE_TTL_MS = 120 * 1000;

// Hash do sid para persistir a sessão sem nunca gravar o sid em claro: um
// vazamento da tabela painel_sessoes não permite sequestrar sessões.
function hashSid(sid) {
    return createHash('sha256').update(String(sid)).digest('hex');
}

// Persiste só a cada PERSIST_THROTTLE_MS para não bater no DB a cada request.
const PERSIST_THROTTLE_MS = 5 * 60 * 1000;

function criarSessao(email) {
    const sid = randomBytes(32).toString('base64url');
    const e = emailNormalizado(email);
    sessoes.set(sid, { email: e, criadaEm: Date.now(), ultimoAcesso: Date.now(), persistAt: Date.now() });
    // Fire-and-forget: a cópia em memória já atende os requests desta instância;
    // a linha no DB só importa após um restart (minutos/horas depois).
    if (usarSupabase()) supa.inserirSessao(hashSid(sid), e).catch(() => {});
    return sid;
}

async function validarSessao(sid) {
    if (!sid) return null;
    let s = sessoes.get(sid);
    if (!s) {
        // Pode ter sido criada antes de um restart do processo: tenta recuperar
        // do Supabase (chave = hash do sid) e reidrata o cache em memória.
        if (usarSupabase()) {
            const persistida = await supa.buscarSessao(hashSid(sid));
            if (persistida) {
                s = { email: persistida.email, criadaEm: persistida.criadaEm, ultimoAcesso: persistida.ultimoAcesso, persistAt: Date.now() };
                sessoes.set(sid, s);
            }
        }
        if (!s) return null;
    }
    if (Date.now() - s.ultimoAcesso > SESSION_TTL_MS) {
        sessoes.delete(sid);
        if (usarSupabase()) supa.removerSessaoDb(hashSid(sid)).catch(() => {});
        return null;
    }
    s.ultimoAcesso = Date.now();
    if (usarSupabase() && Date.now() - (s.persistAt || 0) > PERSIST_THROTTLE_MS) {
        s.persistAt = Date.now();
        supa.tocarSessao(hashSid(sid)).catch(() => {});
    }
    const agora = Date.now();
    let u = s.userCache;
    if (!u || agora - (s.userCacheAt || 0) > USER_CACHE_TTL_MS) {
        u = await buscarUsuario(s.email);
        if (!u) {
            sessoes.delete(sid);
            if (usarSupabase()) supa.removerSessaoDb(hashSid(sid)).catch(() => {});
            return null;
        }
        s.userCache = u;
        s.userCacheAt = agora;
    }
    return {
        email: u.email,
        isAdmin: !!u.isAdmin,
        senhaPrecisaTroca: !!u.senhaPrecisaTroca,
        totpAtivado: !!u.totpAtivado,
        precisa2fa: !!u.precisa2fa,
        // discordId + usuario expostos para o /me e a checagem de plano pro
        // reaproveitarem este fetch em vez de irem ao Supabase de novo.
        discordId: u.discordId || null,
        usuario: u
    };
}

// Zera o cache de usuário de todas as sessões de um email. Chamar logo após
// qualquer escrita no usuário (senha, 2FA, backup) para que o /me reflita na hora.
function invalidarCacheUsuario(email) {
    const e = emailNormalizado(email);
    for (const s of sessoes.values()) {
        if (s.email === e) { s.userCache = null; s.userCacheAt = 0; }
    }
}

function removerSessao(sid) {
    if (!sid) return;
    sessoes.delete(sid);
    if (usarSupabase()) supa.removerSessaoDb(hashSid(sid)).catch(() => {});
}

function removerTodasSessoesDoUsuario(email) {
    const e = emailNormalizado(email);
    for (const [sid, s] of sessoes.entries()) {
        if (s.email === e) sessoes.delete(sid);
    }
    if (usarSupabase()) supa.removerSessoesDoUsuarioDb(e).catch(() => {});
}

// Faxina periódica de sessões expiradas no DB (as que nunca mais foram
// acessadas e por isso não passaram pelo delete lazy do validarSessao).
if (usarSupabase()) {
    setInterval(() => {
        if (usarSupabase()) supa.limparSessoesExpiradas(SESSION_TTL_MS).catch(() => {});
    }, 6 * 60 * 60 * 1000).unref();
}

// ====================== 2FA: BACKUP CODES ======================
function gerarCodigosBackup(n = 10) {
    const codigos = [];
    const hashes = [];
    for (let i = 0; i < n; i++) {
        const c = randomBytes(5).toString('hex'); // 10 chars hex
        codigos.push(c);
        hashes.push(hashSenha(c)); // mesmo esquema scrypt das senhas
    }
    return { codigos, hashes };
}

function verificarCodigoBackup(codigo, hashes) {
    const c = String(codigo || '').trim().toLowerCase();
    const lista = Array.isArray(hashes) ? hashes : [];
    for (let i = 0; i < lista.length; i++) {
        if (verificarSenha(c, lista[i])) {
            return { ok: true, hashesRestantes: lista.slice(0, i).concat(lista.slice(i + 1)) };
        }
    }
    return { ok: false, hashesRestantes: lista };
}

// ====================== 2FA: SEGREDO CIFRADO ======================
// O segredo base32 é cifrado com o mesmo AES-256-GCM dos tokens Discord e
// guardado como string JSON em painel_users.totp_secret_cifrado.
function cifrarSegredoTotp(segredoBase32) {
    return JSON.stringify(cripto.cifrarToken(segredoBase32));
}
function decifrarSegredoTotp(blob) {
    return cripto.decifrarToken(JSON.parse(blob));
}

// ====================== 2FA: DESAFIOS (in-memory) ======================
const desafios2fa = new Map();
const DESAFIO_TTL_MS = 5 * 60 * 1000;
const DESAFIO_MAX_TENT = 5;

function criarDesafio2fa(email) {
    const id = randomBytes(32).toString('base64url');
    desafios2fa.set(id, { email: emailNormalizado(email), criadoEm: Date.now(), tentativas: 0 });
    return id;
}
function obterDesafio2fa(id) {
    const d = desafios2fa.get(id);
    if (!d) return null;
    if (Date.now() - d.criadoEm > DESAFIO_TTL_MS) { desafios2fa.delete(id); return null; }
    return d;
}
function registrarTentativaDesafio(id) {
    const d = desafios2fa.get(id);
    if (!d) return;
    d.tentativas += 1;
    if (d.tentativas >= DESAFIO_MAX_TENT) desafios2fa.delete(id);
}
function consumirDesafio2fa(id) {
    desafios2fa.delete(id);
}

// ====================== PLANO PRO (Discord IDs) ======================
// A tabela de pro_ids muda raramente, mas era consultada em CADA request de
// função (checagem de gate). Cache curto por discordId; invalidado ao add/remover.
const _proCache = new Map(); // discordId -> { ok, at }
const PRO_CACHE_TTL_MS = 60 * 1000;
function invalidarCachePro() { _proCache.clear(); }
async function ehPlanoProPorDiscord(discordId) {
    const did = String(discordId || '').trim();
    if (!did) return false;
    const c = _proCache.get(did);
    const agora = Date.now();
    if (c && agora - c.at < PRO_CACHE_TTL_MS) return c.ok;
    let ok;
    if (usarSupabase()) ok = await supa.ehProId(did);
    else ok = lerProIdsLocal().some((r) => String(r.discordId || r) === did);
    _proCache.set(did, { ok, at: agora });
    return ok;
}
// Dado o email da sessão, descobre o Discord vinculado e checa se é plano pro.
// Busca o discord_id na fonte crua (o buscarUsuario mapeado não expõe esse campo).
async function ehPlanoProPorEmail(email) {
    let did = null;
    if (usarSupabase()) {
        const u = await supa.buscarUsuario(email);
        did = u && u.discord_id;
    } else {
        const alvo = emailNormalizado(email);
        const u = lerUsuariosLocal().find((x) => emailNormalizado(x.email) === alvo);
        did = u && u.discordId;
    }
    return ehPlanoProPorDiscord(did);
}
async function listarProIds() {
    if (usarSupabase()) return supa.listarProIds();
    return lerProIdsLocal().map((r) => (typeof r === 'string' ? { discordId: r } : r));
}
async function adicionarProId(discordId, criadoPor) {
    invalidarCachePro();
    const did = String(discordId || '').trim();
    if (!/^\d{17,20}$/.test(did)) return { sucesso: false, mensagem: 'ID inválido (snowflake de 17-20 dígitos).' };
    if (usarSupabase()) return supa.adicionarProId(did, criadoPor);
    const lista = lerProIdsLocal();
    if (lista.some((r) => String(r.discordId || r) === did)) return { sucesso: false, mensagem: 'ID já é plano pro' };
    lista.push({ discordId: did, criadoEm: Date.now(), criadoPor: criadoPor || null });
    salvarProIdsLocal(lista);
    return { sucesso: true };
}
async function removerProId(discordId) {
    invalidarCachePro();
    const did = String(discordId || '').trim();
    if (usarSupabase()) return supa.removerProId(did);
    salvarProIdsLocal(lerProIdsLocal().filter((r) => String(r.discordId || r) !== did));
    return { sucesso: true };
}

// ====================== FEATURE FLAGS (permissões por função) ======================
async function obterFeatureFlags() {
    if (usarSupabase()) return supa.listarFeatureFlags();
    return lerFeatureFlagsLocal();
}
async function definirFeatureFlag(key, nivel) {
    const n = (String(nivel) === 'pro') ? 'pro' : 'todos';
    const k = String(key || '').trim();
    if (!k) return { sucesso: false, mensagem: 'Função inválida' };
    if (usarSupabase()) return supa.setFeatureFlag(k, n);
    const o = lerFeatureFlagsLocal();
    o[k] = n;
    salvarFeatureFlagsLocal(o);
    return { sucesso: true };
}

module.exports = {
    ehPlanoProPorDiscord,
    ehPlanoProPorEmail,
    listarProIds,
    adicionarProId,
    removerProId,
    obterFeatureFlags,
    definirFeatureFlag,
    inicializarAdminSeNecessario,
    criarUsuario,
    trocarSenha,
    deletarUsuario,
    listarUsuarios,
    autenticar,
    loginOuCriarViaDiscord,
    reconfirmarSenha,
    buscarUsuario,
    criarSessao,
    validarSessao,
    removerSessao,
    removerTodasSessoesDoUsuario,
    invalidarCacheUsuario,
    emailNormalizado,
    dataDir,
    gerarCodigosBackup,
    verificarCodigoBackup,
    cifrarSegredoTotp,
    decifrarSegredoTotp,
    criarDesafio2fa,
    obterDesafio2fa,
    registrarTentativaDesafio,
    consumirDesafio2fa,
};
