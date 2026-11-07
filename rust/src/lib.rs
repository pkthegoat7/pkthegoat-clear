//! GoatCord — núcleo portado para Rust.
//!
//! Este crate reimplementa as partes LEGÍTIMAS e autossuficientes do app:
//! - [`totp`]: 2FA (RFC 6238), compatível com `otpauth://`.
//! - [`crypto`]: AES-256-GCM com chave derivada via scrypt — mesmo formato do
//!   `src/services/crypto.js`, então dados cifrados são interoperáveis.
//! - [`token`]: validação de um token do Discord (o próprio usuário cola o seu).
//! - [`store`]: lista de tokens salvos (cifrados) + limpeza automática dos que
//!   o Discord rejeita (401). Importação é manual — NÃO há varredura da máquina.
//! - [`config`]: preferências simples (delay, cor do painel).
//!
//! Deliberadamente FORA do core:
//! - Coleta/descriptografia de tokens de outros processos (o `buscarTokensWindows`
//!   do Node). Isso é extração de credencial; foi adaptado para importação manual.
//! - Automação de "self-bot" (limpar DMs em massa, automute, scraper, calls) via
//!   token de usuário na gateway — viola o ToS do Discord e as libs Rust
//!   (serenity/twilight) não dão suporte oficial a user-token. Para automação,
//!   migre para a API oficial de Bot.

pub mod config;
pub mod crypto;
pub mod store;
pub mod token;
pub mod totp;
