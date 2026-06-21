#!/usr/bin/env node
/**
 * Escape hatch anti-lockout: desativa o 2FA de uma conta direto no Supabase.
 * Uso (na VPS, com SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ENCRYPTION_KEY no ambiente):
 *   node scripts/2fa-reset.js patricknicoli55@gmail.com
 */
const path = require('path');
const supa = require(path.join(__dirname, '..', 'src', 'services', 'supabase'));

async function main() {
    const email = process.argv[2];
    if (!email) { console.error('Uso: node scripts/2fa-reset.js <email>'); process.exit(1); }
    if (!supa.estaConfigurado()) { console.error('Supabase não configurado (env).'); process.exit(1); }
    const u = await supa.buscarUsuario(email);
    if (!u) { console.error('Usuário não encontrado:', email); process.exit(1); }
    const r = await supa.atualizarTotp(email, {
        totpSecretCifrado: null, totpAtivado: false, totpBackupCodes: null, totpAtivadoEm: null
    });
    if (!r.sucesso) { console.error('Falha:', r.mensagem); process.exit(1); }
    console.log('2FA desativado para', email, '— faça login e reconfigure.');
}
main().catch((e) => { console.error(e); process.exit(1); });
