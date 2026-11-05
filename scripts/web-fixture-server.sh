#!/usr/bin/env bash
# Lifecycle helpers for the throwaway servers started by shared-UI fixtures.
# Only signal the exact child PID started by the calling script.
fixture_server_port_free() {
  if (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; then
    echo "Fixture port $1 is already occupied; refusing to use another server." >&2
    return 1
  fi
}

fixture_server_cleanup() {
  local fixture_pid="$1"
  kill "$fixture_pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 "$fixture_pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$fixture_pid" 2>/dev/null; then
    kill -KILL "$fixture_pid" 2>/dev/null || true
  fi
  wait "$fixture_pid" 2>/dev/null || true
}

fixture_server_ready() {
  local fixture_pid="$1" fixture_port="$2"
  for _ in $(seq 1 60); do
    if ! kill -0 "$fixture_pid" 2>/dev/null; then
      echo 'The fixture server exited before becoming ready; see its retained server.log.' >&2
      return 1
    fi
    if curl -sf "http://127.0.0.1:$fixture_port/api/auth/state" >/dev/null; then
      kill -0 "$fixture_pid" 2>/dev/null && return 0
    fi
    sleep 0.5
  done
  echo 'The fixture server did not become ready; see its retained server.log.' >&2
  return 1
}
