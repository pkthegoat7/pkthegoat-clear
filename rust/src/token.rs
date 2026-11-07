//! Validação de token do Discord — porta de `validarToken`/`verificarTokenValida`
//! (`src/services/tokens.js`). O usuário fornece o PRÓPRIO token; não há coleta.

use std::thread::sleep;
use std::time::Duration;

const API_ME: &str = "https://discord.com/api/v9/users/@me";

/// Estado de um token, sem apagar nada por engano:
/// - `Valida`   -> HTTP 200
/// - `Invalida` -> HTTP 401 (o Discord rejeitou a credencial; pode apagar)
/// - `Indeterminada` -> rede/5xx/403/429-persistente (MANTER o token)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EstadoToken {
    Valida,
    Invalida,
    Indeterminada,
}

fn limpar(token: &str) -> String {
    token
        .replace("Bot", "")
        .replace("Bearer", "")
        .trim()
        .to_string()
}

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .user_agent("GoatCord/1.0")
        .timeout(Duration::from_secs(15))
        .build()
        .expect("client http")
}

/// Retorna `Some(username)` se o token for válido, `None` caso contrário.
/// Faz um retry em caso de 429 (respeitando `retry-after`).
pub fn validar_token(token: &str) -> Option<String> {
    let tok = limpar(token);
    let c = client();
    for tentativa in 0..2 {
        let resp = c.get(API_ME).header("Authorization", &tok).send().ok()?;
        if resp.status().as_u16() == 429 && tentativa == 0 {
            let espera = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(5.0);
            sleep(Duration::from_secs_f64(espera));
            continue;
        }
        if !resp.status().is_success() {
            return None;
        }
        let json: serde_json::Value = resp.json().ok()?;
        return json
            .get("username")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
    }
    None
}

/// Estado tri-estado usado pela limpeza automática (só apaga em `Invalida`).
pub fn verificar_token(token: &str) -> EstadoToken {
    let tok = limpar(token);
    let c = client();
    for tentativa in 0..2 {
        let resp = match c.get(API_ME).header("Authorization", &tok).send() {
            Ok(r) => r,
            Err(_) => return EstadoToken::Indeterminada, // sem internet / erro de rede
        };
        let status = resp.status().as_u16();
        if status == 429 && tentativa == 0 {
            let espera = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(5.0);
            sleep(Duration::from_secs_f64(espera));
            continue;
        }
        if resp.status().is_success() {
            return EstadoToken::Valida;
        }
        if status == 401 {
            return EstadoToken::Invalida;
        }
        // 403, 5xx, 429 persistente: incerto -> não apagar.
        return EstadoToken::Indeterminada;
    }
    EstadoToken::Indeterminada
}
