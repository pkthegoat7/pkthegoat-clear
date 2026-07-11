#!/usr/bin/env node

// Entrada da build LOCAL (uso pessoal no PC, sem login).
// Liga o modo local ANTES de qualquer require do servidor: o painel abre direto,
// sem tela de login e sem Supabase. Os dados ficam nos JSON locais em ./data.
process.env.PKTHEGOAT_LOCAL = '1';

// Garante que PORT nunca vaze de um ambiente qualquer e ligue o modo produção
// (que reexigiria login e desligaria o modo local).
delete process.env.PORT;

// ENCRYPTION_KEY só é usada se algum caminho cifrar (não acontece no armazenamento
// local, que grava em texto plano). Definimos uma padrão só pra blindar contra um
// require que toque no módulo de crypto sem a env presente.
if (!process.env.ENCRYPTION_KEY) {
	process.env.ENCRYPTION_KEY = 'pkthegoat-local-default-encryption-key-32b+';
}

require('./index.js');
