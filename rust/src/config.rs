//! Preferências simples do painel — porta enxuta de `config/configuracao.js`.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "delay_padrao")]
    pub delay: u64,
    #[serde(default = "cor_padrao")]
    pub cor_painel: String,
    #[serde(default)]
    pub esperar_fetch: bool,
    #[serde(default)]
    pub desativar_rpc: bool,
}

fn delay_padrao() -> u64 {
    1000
}
fn cor_padrao() -> String {
    "#5865f2".to_string() // blurple (GoatCord)
}

impl Default for Config {
    fn default() -> Self {
        Config {
            delay: delay_padrao(),
            cor_painel: cor_padrao(),
            esperar_fetch: false,
            desativar_rpc: false,
        }
    }
}

fn caminho() -> anyhow::Result<PathBuf> {
    let base = dirs::data_dir().ok_or_else(|| anyhow::anyhow!("sem diretório de dados do SO"))?;
    let dir = base.join("GoatCord").join("data");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("config-rs.json"))
}

pub fn carregar() -> anyhow::Result<Config> {
    let p = caminho()?;
    if !p.exists() {
        return Ok(Config::default());
    }
    Ok(serde_json::from_str(&std::fs::read_to_string(p)?).unwrap_or_default())
}

pub fn salvar(c: &Config) -> anyhow::Result<()> {
    std::fs::write(caminho()?, serde_json::to_string_pretty(c)?)?;
    Ok(())
}
