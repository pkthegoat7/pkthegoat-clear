# GoatCord — núcleo em Rust

Porta das partes **legítimas e autossuficientes** do GoatCord para Rust, como
biblioteca (`goatcord_core`) reutilizável + uma CLI de demonstração (`goatcord`).

> ⚠️ Rust não estava instalado na máquina quando este código foi escrito, então
> ele **ainda não foi compilado aqui**. É idiomático e feito para compilar; rode
> `cargo build` depois de instalar o toolchain (abaixo) e ajuste se algo acusar.

## O que foi portado / adaptado / deixado de fora

| Original (Node) | Rust | Observação |
|---|---|---|
| `services/totp.js` | ✅ `src/totp.rs` | RFC 6238, HMAC-SHA1, base32, `otpauth://` |
| `services/crypto.js` | ✅ `src/crypto.rs` | AES-256-GCM + scrypt, **formato compatível** com o Node |
| `services/tokens.js` → `validarToken`/`verificarTokenValida` | ✅ `src/token.rs` | validação do próprio token; tri-estado (401 = inválido) |
| auto-apagar token inválida | ✅ `src/store.rs::limpar_invalidas` | só remove em 401; rede/5xx/403 preserva |
| tokens salvos (add/list/remove) | ✅ `src/store.rs` | cifrados em disco |
| `config/configuracao.js` | ✅ `src/config.rs` | delay, cor do painel, flags |
| `services/tokens.js` → `buscarTokensWindows` | 🔁 **adaptado** | **importação manual** (`token-add`); **não** varre/descriptografa tokens da máquina |
| self-bot: `limpar`, `automute`, `scraper`, `calls`, `clonar`, backups via user-token | ⛔ **fora do core** | user-token viola o ToS do Discord e não é suportado por serenity/twilight; para automação use a **API oficial de Bot** |
| painel web (`web-ui.html`) | ➡️ futuro | reaproveitável num app **Tauri** (webview), consumindo esta lib |

### Por que a coleta de token não foi portada
`buscarTokensWindows` lê o LevelDB do Discord e descriptografa os tokens com
DPAPI+AES — a mesma técnica de "token stealer". Recriar isso em outra linguagem
é escrever extração de credencial, então foi substituído por importação manual
(você cola o seu próprio token).

## Instalar o Rust
```powershell
winget install Rustlang.Rustup   # ou: https://rustup.rs
rustup default stable
```

## Build e uso
```powershell
cd rust
cargo build --release
# binário em target/release/goatcord.exe

# exemplos:
$env:ENCRYPTION_KEY = "uma-chave-forte-com-32+-bytes-aqui!!!"   # p/ cifrar tokens
cargo run -- gen-secret
cargo run -- totp JBSWY3DPEHPK3PXP
cargo run -- token-check "SEU_TOKEN_AQUI"
cargo run -- token-add "SEU_TOKEN_AQUI" --nome principal
cargo run -- token-list
cargo run -- token-clean        # apaga só os que o Discord rejeita (401)
cargo run -- config-get
```

## Testes
```powershell
cargo test
```
Inclui vetor RFC 6238 do TOTP e round-trip do AES-GCM.

## Dados
Fica em `%APPDATA%\GoatCord\data` (Windows), alinhado ao app Electron após o
rebrand: `tokens-rs.json` (tokens cifrados) e `config-rs.json`.
