//! CLI de demonstração do núcleo GoatCord em Rust.
//! Expõe só funções legítimas: 2FA, validação/armazenamento do próprio token,
//! cripto e config. Nada de coleta de credenciais ou automação self-bot.

use clap::{Parser, Subcommand};
use goatcord_core::{config, crypto, store, token, totp};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Parser)]
#[command(name = "goatcord", version, about = "GoatCord core (Rust) — utilitários locais")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Gera um segredo TOTP aleatório (base32).
    GenSecret,
    /// Mostra o código TOTP atual para um segredo base32.
    Totp { secret: String },
    /// Monta a URI otpauth:// (para QR code).
    TotpUri { email: String, secret: String },
    /// Verifica se um token do Discord é válido (mostra o username).
    TokenCheck { token: String },
    /// Adiciona o seu token à lista (cifrado). Importação manual.
    TokenAdd {
        token: String,
        #[arg(long)]
        nome: Option<String>,
    },
    /// Lista os nomes dos tokens salvos.
    TokenList,
    /// Remove um token salvo pelo nome.
    TokenRm { nome: String },
    /// Apaga automaticamente os tokens que o Discord rejeita (401).
    TokenClean,
    /// Cifra um texto (AES-256-GCM) e imprime o JSON do blob.
    Encrypt { texto: String },
    /// Decifra um blob JSON ({token_cifrado,iv,auth_tag}).
    Decrypt { json: String },
    /// Mostra a config atual.
    ConfigGet,
}

fn agora_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::GenSecret => println!("{}", totp::gerar_segredo(20)),
        Cmd::Totp { secret } => println!("{}", totp::codigo_totp(&secret, agora_ms(), 30)?),
        Cmd::TotpUri { email, secret } => {
            println!("{}", totp::montar_uri(&email, &secret, "GoatCord"))
        }
        Cmd::TokenCheck { token } => match token::validar_token(&token) {
            Some(u) => println!("válido — usuário: {u}"),
            None => println!("inválido ou não verificável"),
        },
        Cmd::TokenAdd { token, nome } => {
            let n = store::adicionar(nome.as_deref(), &token)?;
            println!("salvo: {n}");
        }
        Cmd::TokenList => {
            let lista = store::listar()?;
            if lista.is_empty() {
                println!("(nenhum token salvo)");
            } else {
                for n in lista {
                    println!("- {n}");
                }
            }
        }
        Cmd::TokenRm { nome } => {
            println!("{}", if store::remover(&nome)? { "removido" } else { "não encontrado" });
        }
        Cmd::TokenClean => {
            let removidos = store::limpar_invalidas()?;
            if removidos.is_empty() {
                println!("nenhuma token inválida.");
            } else {
                println!("removidas ({}): {}", removidos.len(), removidos.join(", "));
            }
        }
        Cmd::Encrypt { texto } => {
            println!("{}", serde_json::to_string(&crypto::cifrar_token(&texto)?)?)
        }
        Cmd::Decrypt { json } => {
            let c: crypto::Cifrado = serde_json::from_str(&json)?;
            println!("{}", crypto::decifrar_token(&c)?);
        }
        Cmd::ConfigGet => println!("{}", serde_json::to_string_pretty(&config::carregar()?)?),
    }
    Ok(())
}
