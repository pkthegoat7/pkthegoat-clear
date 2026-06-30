#!/usr/bin/env bash
# Sobe o PulseAudio (sink nulo) antes do servidor. O Chromium "new headless"
# renderiza offscreen (sem Xvfb) e manda o áudio para o sink "virtual"; o
# `parec` captura o monitor desse sink.

set -u

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/pa-runtime}"
mkdir -p "$XDG_RUNTIME_DIR" 2>/dev/null || true
chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true

pulseaudio -D --exit-idle-time=-1 \
  --load="module-null-sink sink_name=virtual sink_properties=device.description=virtual" \
  --load="module-always-sink" >/tmp/pulse.log 2>&1 || true

sleep 1
pactl set-default-sink virtual >/dev/null 2>&1 || true
# Sem suspend-on-idle: o null sink não é suspenso por ociosidade.
pactl unload-module module-suspend-on-idle >/dev/null 2>&1 || true
# (O silêncio que mantém o sink RUNNING é spawnado pelo server.js, com respawn.)

# Diagnóstico do PulseAudio (aparece nos logs do Railway).
if pulseaudio --check 2>/dev/null; then echo "[diag] pulseaudio RUNNING"; else echo "[diag] pulseaudio NAO esta rodando"; fi
echo "[diag] sinks:"; pactl list short sinks 2>&1 | sed 's/^/[diag-sink] /'
echo "[diag] sources:"; pactl list short sources 2>&1 | sed 's/^/[diag-src] /'

exec node server.js
