#!/usr/bin/env bash

# Shared by start/status. Keep health checks on loopback, while presenting every
# usable IPv4 address to operators who open the workbench from another device.
atlas_print_access_urls() {
  local atlas_port="$1"
  local atlas_bind_host="${2:-0.0.0.0}"

  printf '本机访问: http://127.0.0.1:%s\n' "$atlas_port"

  if [[ "$atlas_bind_host" != "0.0.0.0" && "$atlas_bind_host" != "::" ]]; then
    if [[ "$atlas_bind_host" != "127.0.0.1" && "$atlas_bind_host" != "localhost" ]]; then
      printf '网络访问: http://%s:%s\n' "$atlas_bind_host" "$atlas_port"
    fi
    return
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo '局域网地址检测失败：未找到 Node.js，请使用本机局域网 IP 加端口访问'
    return
  fi

  local atlas_network_urls
  atlas_network_urls="$(node - "$atlas_port" <<'NODE'
const os = require('node:os');
const port = process.argv[2];
const addresses = new Set();
for (const entries of Object.values(os.networkInterfaces())) {
  for (const entry of entries || []) {
    const ipv4 = entry.family === 'IPv4' || entry.family === 4;
    if (ipv4 && !entry.internal && entry.address) addresses.add(entry.address);
  }
}
for (const address of [...addresses].sort()) {
  console.log(`局域网访问: http://${address}:${port}`);
}
NODE
)"

  if [[ -n "$atlas_network_urls" ]]; then
    printf '%s\n' "$atlas_network_urls"
  else
    echo '未检测到局域网 IPv4 地址，请确认服务器已经连接网络'
  fi
}

atlas_command_is_loopback_only() {
  local atlas_command="${1:-}"
  local atlas_recorded_host="${2:-}"
  [[ "$atlas_recorded_host" == "127.0.0.1" || "$atlas_recorded_host" == "localhost" \
    || "$atlas_command" == *"--host 127.0.0.1"* \
    || "$atlas_command" == *"--host=127.0.0.1"* \
    || "$atlas_command" == *"--host localhost"* \
    || "$atlas_command" == *"--host=localhost"* ]]
}
