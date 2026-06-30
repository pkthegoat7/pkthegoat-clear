#!/usr/bin/env bash
# Sobe um display virtual (Xvfb) + PulseAudio com sink nulo antes do servidor.
# Chromium roda "headed" sob o Xvfb (melhor para áudio e menos detectável); o
# som vai para o sink "virtual" e o ffmpeg captura o monitor dele.

set -u

# ---- Display virtual ----
rm -f /tmp/.X99-lock 2>/dev/null || true
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
export DISPLAY=:99

# ---- PulseAudio (por-usuário; o container roda como pwuser) ----
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/pa-runtime}"
mkdir -p "$XDG_RUNTIME_DIR" 2>/dev/null || true
chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true

pulseaudio -D --exit-idle-time=-1 \
  --load="module-null-sink sink_name=virtual sink_properties=device.description=virtual" \
  --load="module-always-sink" >/tmp/pulse.log 2>&1 || true

# espera o pulse subir e fixa o sink virtual como padrão
sleep 1
pactl set-default-sink virtual >/dev/null 2>&1 || true

exec node server.js
