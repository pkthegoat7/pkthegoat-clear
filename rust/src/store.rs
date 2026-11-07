//! Armazenamento de tokens salvos (cifrados em disco) + limpeza automática dos
//! inválidos. Adaptação de `services/tokens.js` + a feature "auto-apagar token
//! inválida": a IMPORTAÇÃO é manual (o usuário cola o token), sem varrer a máquina.

use crate::crypto::{cifrar_token, decifrar_token, Cifrado};
use crate::token::{validar_token, verificar_token, EstadoToken};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenSalvo {
    pub nome: String,
    #[serde(flatten)]
    pub cifrado: Cifrado,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Arquivo {
    #[serde(default)]
    tokens: Vec<TokenSalvo>,
}

/// Pasta de dados: `%APPDATA%\GoatCord\data` (Windows) / `~/.local/share/GoatCord/data`.
/// Alinhada ao userData do app Electron após o rebrand.
fn data_dir() -> anyhow::Result<PathBuf> {
    let base = dirs::data_dir().ok_or_else(|| anyhow::anyhow!("sem diretório de dados do SO"))?;
    let dir = base.join("GoatCord").join("data");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn caminho() -> anyhow::Result<PathBuf> {
    Ok(data_dir()?.join("tokens-rs.json"))
}

fn carregar() -> anyhow::Result<Arquivo> {
    let p = caminho()?;
    if !p.exists() {
        return Ok(Arquivo::default());
    }
    let txt = std::fs::read_to_string(p)?;
    Ok(serde_json::from_str(&txt).unwrap_or_default())
}

fn salvar(a: &Arquivo) -> anyhow::Result<()> {
    std::fs::write(caminho()?, serde_json::to_string_pretty(a)?)?;
    Ok(())
}

/// Lista os nomes dos tokens salvos.
pub fn listar() -> anyhow::Result<Vec<String>> {
    Ok(carregar()?.tokens.into_iter().map(|t| t.nome).collect())
}

/// Adiciona um token: valida na API, usa o username como nome se nenhum for dado,
/// cifra e persiste. Retorna o nome final gravado.
pub fn adicionar(nome: Option<&str>, token: &str) -> anyhow::Result<String> {
    let usuario = validar_token(token).ok_or_else(|| anyhow::anyhow!("token inválido"))?;
    let nome_final = nome
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(&usuario)
        .to_string();

    let mut a = carregar()?;
    if a.tokens.iter().any(|t| t.nome == nome_final) {
        anyhow::bail!("já existe um token com o nome '{nome_final}'");
    }
    a.tokens.push(TokenSalvo {
        nome: nome_final.clone(),
        cifrado: cifrar_token(token)?,
    });
    salvar(&a)?;
    Ok(nome_final)
}

/// Remove um token pelo nome. `true` se removeu.
pub fn remover(nome: &str) -> anyhow::Result<bool> {
    let mut a = carregar()?;
    let antes = a.tokens.len();
    a.tokens.retain(|t| t.nome != nome);
    let removeu = a.tokens.len() != antes;
    if removeu {
        salvar(&a)?;
    }
    Ok(removeu)
}

/// Decifra e retorna o valor de um token salvo.
pub fn valor(nome: &str) -> anyhow::Result<String> {
    let a = carregar()?;
    let t = a
        .tokens
        .iter()
        .find(|t| t.nome == nome)
        .ok_or_else(|| anyhow::anyhow!("token '{nome}' não encontrado"))?;
    decifrar_token(&t.cifrado)
}

/// Remove apenas os tokens que o Discord REJEITA (401). Rede/5xx/403 preservam.
/// Retorna os nomes removidos.
pub fn limpar_invalidas() -> anyhow::Result<Vec<String>> {
    let a = carregar()?;
    let mut removidos = Vec::new();
    let mut restantes = Vec::new();
    for t in a.tokens {
        let estado = match decifrar_token(&t.cifrado) {
            Ok(tok) => verificar_token(&tok),
            Err(_) => EstadoToken::Indeterminada, // não conseguiu decifrar -> não apaga
        };
        if estado == EstadoToken::Invalida {
            removidos.push(t.nome);
        } else {
            restantes.push(t);
        }
    }
    if !removidos.is_empty() {
        salvar(&Arquivo { tokens: restantes })?;
    }
    Ok(removidos)
}
