//! TOTP (RFC 6238) — porta fiel de `src/services/totp.js`.
//! HMAC-SHA1, passo de 30s, 6 dígitos, segredo em base32 (compatível `otpauth://`).

use hmac::{Hmac, Mac};
use rand::RngCore;
use sha1::Sha1;

type HmacSha1 = Hmac<Sha1>;

const BASE32_ALFA: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// Codifica bytes em base32 (sem padding), igual ao `base32Encode` do JS.
pub fn base32_encode(buf: &[u8]) -> String {
    let mut bits = 0u32;
    let mut valor = 0u32;
    let mut saida = String::new();
    for &byte in buf {
        valor = (valor << 8) | byte as u32;
        bits += 8;
        while bits >= 5 {
            let idx = ((valor >> (bits - 5)) & 31) as usize;
            saida.push(BASE32_ALFA[idx] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        let idx = ((valor << (5 - bits)) & 31) as usize;
        saida.push(BASE32_ALFA[idx] as char);
    }
    saida
}

/// Decodifica base32 (ignora espaços e `=` ao final). Erro em caractere inválido.
pub fn base32_decode(s: &str) -> anyhow::Result<Vec<u8>> {
    let limpo: String = s
        .to_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '=')
        .collect();
    let mut bits = 0u32;
    let mut valor = 0u32;
    let mut bytes = Vec::new();
    for ch in limpo.bytes() {
        let idx = BASE32_ALFA
            .iter()
            .position(|&b| b == ch)
            .ok_or_else(|| anyhow::anyhow!("Base32 inválido"))? as u32;
        valor = (valor << 5) | idx;
        bits += 5;
        if bits >= 8 {
            bytes.push(((valor >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
    }
    Ok(bytes)
}

/// Gera um segredo aleatório em base32 (20 bytes por padrão).
pub fn gerar_segredo(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    base32_encode(&buf)
}

/// HOTP: código de 6 dígitos para um contador arbitrário.
pub fn gerar_codigo(secret_base32: &str, contador: u64) -> anyhow::Result<String> {
    let chave = base32_decode(secret_base32)?;
    let mut mac = HmacSha1::new_from_slice(&chave).map_err(|e| anyhow::anyhow!(e.to_string()))?;
    mac.update(&contador.to_be_bytes());
    let hmac = mac.finalize().into_bytes();
    let offset = (hmac[hmac.len() - 1] & 0xf) as usize;
    let bin = (((hmac[offset] & 0x7f) as u32) << 24)
        | ((hmac[offset + 1] as u32) << 16)
        | ((hmac[offset + 2] as u32) << 8)
        | (hmac[offset + 3] as u32);
    Ok(format!("{:06}", bin % 1_000_000))
}

/// TOTP para um instante em milissegundos (passo de 30s por padrão).
pub fn codigo_totp(secret_base32: &str, t_ms: u128, passo: u64) -> anyhow::Result<String> {
    let contador = ((t_ms / 1000) as u64) / passo;
    gerar_codigo(secret_base32, contador)
}

/// Verifica um código dentro de uma janela de passos. Retorna o contador que
/// casou (para o chamador rejeitar replay), ou `None`.
pub fn verificar_com_step(
    secret_base32: &str,
    codigo: &str,
    t_ms: u128,
    janela: i64,
    passo: u64,
) -> Option<u64> {
    if codigo.len() != 6 || !codigo.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let base = ((t_ms / 1000) as u64) / passo;
    for i in -janela..=janela {
        let contador = base as i64 + i;
        if contador < 0 {
            continue;
        }
        let contador = contador as u64;
        if let Ok(esperado) = gerar_codigo(secret_base32, contador) {
            // Comparação byte a byte de comprimento fixo (ambos 6 dígitos).
            if esperado.as_bytes().ct_eq_simple(codigo.as_bytes()) {
                return Some(contador);
            }
        }
    }
    None
}

/// `true` se o código é válido na janela dada.
pub fn verificar(secret_base32: &str, codigo: &str, t_ms: u128, janela: i64, passo: u64) -> bool {
    verificar_com_step(secret_base32, codigo, t_ms, janela, passo).is_some()
}

/// Monta a URI `otpauth://totp/...` para QR code. Emissor padrão: "GoatCord".
pub fn montar_uri(email: &str, secret_base32: &str, emissor: &str) -> String {
    let enc = |s: &str| {
        // percent-encode simples dos caracteres problemáticos em label/params.
        let mut out = String::new();
        for b in s.bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    out.push(b as char)
                }
                _ => out.push_str(&format!("%{:02X}", b)),
            }
        }
        out
    };
    let label = format!("{}:{}", enc(emissor), enc(email));
    format!(
        "otpauth://totp/{}?secret={}&issuer={}&algorithm=SHA1&digits=6&period=30",
        label,
        enc(secret_base32),
        enc(emissor)
    )
}

/// Comparação simples de igualdade entre slices de bytes (comprimento + conteúdo).
trait CtEqSimple {
    fn ct_eq_simple(&self, other: &[u8]) -> bool;
}
impl CtEqSimple for [u8] {
    fn ct_eq_simple(&self, other: &[u8]) -> bool {
        if self.len() != other.len() {
            return false;
        }
        let mut diff = 0u8;
        for (a, b) in self.iter().zip(other.iter()) {
            diff |= a ^ b;
        }
        diff == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_roundtrip() {
        let data = b"hello world";
        let enc = base32_encode(data);
        assert_eq!(base32_decode(&enc).unwrap(), data);
    }

    #[test]
    fn totp_vetor_rfc6238() {
        // Segredo "12345678901234567890" (ASCII) em base32 = GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
        let secret = base32_encode(b"12345678901234567890");
        // t=59s -> contador 1 (passo 30) -> código conhecido 94287082 truncado a 6? (SHA1)
        let code = codigo_totp(&secret, 59_000, 30).unwrap();
        assert_eq!(code, "287082");
    }
}
