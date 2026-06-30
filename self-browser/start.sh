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
# Toca silêncio contínuo no sink para mantê-lo SEMPRE running — assim o monitor
# nunca fica mudo e o parec sempre tem dados (silêncio quando ocioso, áudio real
# quando o Discord toca numa call).
( pacat --device=virtual --rate=48000 --channels=1 --format=s16le /dev/zero >/dev/null 2>&1 & )

exec node server.js
