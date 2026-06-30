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

exec node server.js
