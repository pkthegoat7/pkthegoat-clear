//! Cripto simétrica — porta de `src/services/crypto.js`.
//! AES-256-GCM, chave de 32 bytes derivada de `ENCRYPTION_KEY` via scrypt com
//! salt fixo. Formato de saída (base64 de ciphertext/iv/tag) é o MESMO do Node,
//! então um blob cifrado por um lado é decifrável pelo outro.

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use scrypt::{scrypt, Params};
use serde::{Deserialize, Serialize};

const SALT: &[u8] = b"pkthegoat-painel-salt";
const MIN_ENTROPY_BYTES: usize = 32;
// Mesmo default do modo local do app Electron (electron/main.js). Não é segredo:
// é a chave padrão de uma build pessoal rodando na própria máquina.
const LOCAL_DEFAULT_KEY: &str = "pkthegoat-local-default-encryption-key-32b+";

/// Blob cifrado persistível (campos idênticos ao objeto do crypto.js).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cifrado {
    pub token_cifrado: String,
    pub iv: String,
    pub auth_tag: String,
}

fn env_key() -> String {
    std::env::var("ENCRYPTION_KEY").unwrap_or_else(|_| LOCAL_DEFAULT_KEY.to_string())
}

/// Chave atual (scrypt N=2^15, r=8, p=1). Bloqueia env fraca (<32 bytes), igual ao JS.
fn obter_chave() -> anyhow::Result<[u8; 32]> {
    derivar(15)
}

/// Chave legada (parâmetros antigos do Node, N=2^14) para decifrar dados pré-hardening.
fn obter_chave_legacy() -> anyhow::Result<[u8; 32]> {
    derivar(14)
}

fn derivar(log_n: u8) -> anyhow::Result<[u8; 32]> {
    let env = env_key();
    if env.len() < MIN_ENTROPY_BYTES {
        anyhow::bail!(
            "ENCRYPTION_KEY tem {} bytes — mínimo {}. Gere com `openssl rand -base64 32`.",
            env.len(),
            MIN_ENTROPY_BYTES
        );
    }
    let params = Params::new(log_n, 8, 1, 32)?;
    let mut key = [0u8; 32];
    scrypt(env.as_bytes(), SALT, &params, &mut key)
        .map_err(|e| anyhow::anyhow!("scrypt falhou: {e}"))?;
    Ok(key)
}

/// Cifra um texto em claro. IV de 12 bytes aleatório; tag GCM de 16 bytes separada.
pub fn cifrar_token(plain: &str) -> anyhow::Result<Cifrado> {
    let key_bytes = obter_chave()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 12 bytes
    let mut ct = cipher
        .encrypt(&nonce, plain.as_bytes())
        .map_err(|e| anyhow::anyhow!("falha ao cifrar: {e}"))?;
    // aes-gcm anexa a tag (16 bytes) ao final do ciphertext; separamos como no JS.
    let tag = ct.split_off(ct.len() - 16);
    Ok(Cifrado {
        token_cifrado: B64.encode(&ct),
        iv: B64.encode(nonce.as_slice()),
        auth_tag: B64.encode(&tag),
    })
}

/// Decifra um blob. Tenta a chave atual e cai na legada (dados antigos), como o JS.
pub fn decifrar_token(c: &Cifrado) -> anyhow::Result<String> {
    let iv = B64.decode(&c.iv)?;
    let tag = B64.decode(&c.auth_tag)?;
    let dados = B64.decode(&c.token_cifrado)?;
    let mut combinado = dados.clone();
    combinado.extend_from_slice(&tag);
    let nonce = Nonce::from_slice(&iv);

    for key_fn in [obter_chave as fn() -> anyhow::Result<[u8; 32]>, obter_chave_legacy] {
        if let Ok(key_bytes) = key_fn() {
            let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
            if let Ok(dec) = cipher.decrypt(nonce, combinado.as_ref()) {
                return Ok(String::from_utf8_lossy(&dec).into_owned());
            }
        }
    }
    anyhow::bail!("não foi possível decifrar (chave incorreta ou dados corrompidos)")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        std::env::set_var("ENCRYPTION_KEY", "uma-chave-de-teste-com-mais-de-32-bytes!!");
        let c = cifrar_token("segredo-abc").unwrap();
        assert_eq!(decifrar_token(&c).unwrap(), "segredo-abc");
    }
}
