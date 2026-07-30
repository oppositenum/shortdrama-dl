#!/usr/bin/env bash

# Ensure that the Android device used by the App-capture path is available.
# The script is intentionally usable both by Electron and from a terminal.

set -euo pipefail

MODE="ensure"
INSTALL_MISSING=0
AVD_NAME="${SHORTDRAMA_AVD_NAME:-hongguo}"
ANDROID_API="${SHORTDRAMA_ANDROID_API:-34}"
BOOT_TIMEOUT="${SHORTDRAMA_BOOT_TIMEOUT:-420}"

# Canonical emulator hardware profile. Every managed AVD is forced to exactly
# these values so that all emulators — regardless of host machine or CPU — are
# identical. Physical devices are used as-is (see enforce_runtime_spec).
# The defaults match the pixel_6 profile the AVD is created from (1080x2400@420)
# and the resolution the Python grab script's finders assume.
SCREEN_W="${SHORTDRAMA_SCREEN_W:-1080}"
SCREEN_H="${SHORTDRAMA_SCREEN_H:-2400}"
SCREEN_DPI="${SHORTDRAMA_SCREEN_DPI:-420}"
RAM_MB="${SHORTDRAMA_RAM_MB:-4096}"
VM_HEAP_MB="${SHORTDRAMA_VM_HEAP_MB:-512}"
DATA_MB="${SHORTDRAMA_DATA_MB:-8192}"
CPU_CORES="${SHORTDRAMA_CPU_CORES:-4}"

usage() {
  cat <<'EOF'
Usage: start_avd.sh [--check|--ensure] [--install-missing]

  --check            Inspect only. Do not install packages or start an AVD.
  --ensure           Start a configured device/AVD and wait until it is ready.
  --install-missing  Install Android SDK packages and create the AVD if needed.

Environment overrides:
  ANDROID_SERIAL, ANDROID_HOME, ANDROID_SDK_ROOT
  SHORTDRAMA_AVD_NAME, SHORTDRAMA_ANDROID_API, SHORTDRAMA_ANDROID_ARCH
  SHORTDRAMA_BOOT_TIMEOUT, SHORTDRAMA_SDK_ROOT

Canonical emulator hardware profile (forced on every managed AVD):
  SHORTDRAMA_SCREEN_W (1080), SHORTDRAMA_SCREEN_H (2400), SHORTDRAMA_SCREEN_DPI (420)
  SHORTDRAMA_RAM_MB (4096), SHORTDRAMA_VM_HEAP_MB (512), SHORTDRAMA_DATA_MB (8192)
  SHORTDRAMA_CPU_CORES (4)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check" ;;
    --ensure) MODE="ensure" ;;
    --install-missing) INSTALL_MISSING=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

log() {
  printf '[Android] %s\n' "$*"
}

state() {
  local name="$1"
  shift
  printf '__SHORTDRAMA_STATE__ state=%s' "$name"
  if [[ $# -gt 0 ]]; then printf ' %s' "$@"; fi
  printf '\n'
}

fail() {
  local code="$1"
  local name="$2"
  shift 2
  log "$*"
  state "$name"
  exit "$code"
}

case "$(uname -s)" in
  Darwin)
    DEFAULT_SDK_ROOT="${HOME}/Library/Android/sdk"
    ;;
  Linux)
    DEFAULT_SDK_ROOT="${HOME}/Android/Sdk"
    ;;
  *)
    fail 19 unsupported_host "Automatic Android environment setup currently supports macOS and Linux hosts"
    ;;
esac

SDK_ROOT="${SHORTDRAMA_SDK_ROOT:-${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$DEFAULT_SDK_ROOT}}}"

find_tool() {
  local name="$1"
  local candidate
  for candidate in \
    "${SDK_ROOT}/platform-tools/${name}" \
    "${SDK_ROOT}/emulator/${name}" \
    "${SDK_ROOT}/cmdline-tools/latest/bin/${name}" \
    "/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin/${name}" \
    "/usr/local/share/android-commandlinetools/cmdline-tools/latest/bin/${name}"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return 0
  fi
  return 1
}

refresh_tools() {
  ADB="$(find_tool adb || true)"
  EMULATOR="$(find_tool emulator || true)"
  SDKMANAGER="$(find_tool sdkmanager || true)"
  AVDMANAGER="$(find_tool avdmanager || true)"
}

device_lines() {
  if [[ -z "$ADB" ]]; then return 0; fi
  "$ADB" devices 2>/dev/null | awk 'NR > 1 && $2 == "device" { print $1 }'
}

pick_ready_device() {
  local devices serial
  if [[ -n "${ANDROID_SERIAL:-}" ]]; then
    if [[ -n "$ADB" ]] && [[ "$("$ADB" -s "$ANDROID_SERIAL" get-state 2>/dev/null || true)" == "device" ]]; then
      printf '%s\n' "$ANDROID_SERIAL"
      return 0
    fi
    return 1
  fi

  devices="$(device_lines)"
  serial="$(printf '%s\n' "$devices" | awk '/^emulator-/ { print; exit }')"
  if [[ -n "$serial" ]]; then
    printf '%s\n' "$serial"
    return 0
  fi
  if [[ "$(printf '%s\n' "$devices" | awk 'NF { n++ } END { print n+0 }')" == "1" ]]; then
    printf '%s\n' "$devices" | awk 'NF { print; exit }'
    return 0
  fi
  return 1
}

avd_exists() {
  [[ -n "$EMULATOR" ]] && "$EMULATOR" -list-avds 2>/dev/null | awk -v avd="$AVD_NAME" '$0 == avd { found=1 } END { exit !found }'
}

host_arch() {
  if [[ -n "${SHORTDRAMA_ANDROID_ARCH:-}" ]]; then
    printf '%s\n' "$SHORTDRAMA_ANDROID_ARCH"
    return
  fi
  case "$(uname -m)" in
    arm64|aarch64) printf 'arm64-v8a\n' ;;
    x86_64|amd64) printf 'x86_64\n' ;;
    *) fail 18 unsupported_arch "Unsupported host CPU architecture: $(uname -m)" ;;
  esac
}

avd_config_path() {
  local home="${ANDROID_AVD_HOME:-}"
  if [[ -z "$home" && -n "${ANDROID_SDK_HOME:-}" ]]; then
    home="${ANDROID_SDK_HOME}/.android/avd"
  fi
  home="${home:-$HOME/.android/avd}"
  printf '%s/%s.avd/config.ini\n' "$home" "$AVD_NAME"
}

set_ini_key() {  # file key value
  # Drop every existing line for this key (config.ini may use either "key=value"
  # or "key = value" — Android Studio writes spaces, avdmanager does not), then
  # append the canonical spaceless form. Guarantees exactly one occurrence.
  local file="$1" key="$2" val="$3" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -F'=' '{ lhs=$1; gsub(/[ \t]/,"",lhs) } lhs==k { next } { print }' \
    "$file" >"$tmp"
  printf '%s=%s\n' "$key" "$val" >>"$tmp"
  mv "$tmp" "$file"
}

# Rewrite the AVD's config.ini so its hardware matches the canonical profile
# exactly. Idempotent: safe to run on an existing AVD before every start.
normalize_avd_config() {
  local cfg
  cfg="$(avd_config_path)"
  if [[ ! -f "$cfg" ]]; then return 0; fi
  set_ini_key "$cfg" hw.lcd.width "$SCREEN_W"
  set_ini_key "$cfg" hw.lcd.height "$SCREEN_H"
  set_ini_key "$cfg" hw.lcd.density "$SCREEN_DPI"
  set_ini_key "$cfg" hw.ramSize "$RAM_MB"
  set_ini_key "$cfg" vm.heapSize "$VM_HEAP_MB"
  set_ini_key "$cfg" disk.dataPartition.size "${DATA_MB}M"
  set_ini_key "$cfg" hw.cpu.ncore "$CPU_CORES"
  set_ini_key "$cfg" hw.keyboard yes
  set_ini_key "$cfg" hw.gpu.enabled yes
  set_ini_key "$cfg" hw.gpu.mode auto
  log "Normalized ${AVD_NAME}: ${SCREEN_W}x${SCREEN_H}@${SCREEN_DPI}dpi, ${RAM_MB}MB RAM, ${VM_HEAP_MB}MB heap, ${CPU_CORES} cores"
}

# After a device is ready, force the canonical resolution/density on emulators so
# every emulator is byte-for-byte identical. Physical devices are left untouched.
enforce_runtime_spec() {
  local serial="$1" qemu is_emu=0 cur_size mem_kb ram_target_kb
  qemu="$("$ADB" -s "$serial" shell getprop ro.boot.qemu 2>/dev/null | tr -d '\r' || true)"
  if [[ -z "$qemu" ]]; then
    qemu="$("$ADB" -s "$serial" shell getprop ro.kernel.qemu 2>/dev/null | tr -d '\r' || true)"
  fi
  if [[ "$qemu" == "1" || "$serial" == emulator-* ]]; then is_emu=1; fi

  if [[ "$is_emu" != "1" ]]; then
    cur_size="$("$ADB" -s "$serial" shell wm size 2>/dev/null | tr -d '\r' | awk -F': ' '/size/{v=$2} END{print v}')"
    log "Physical device ${serial}; using as-is (size=${cur_size:-unknown}). Emulator-only params are not forced on real hardware."
    return 0
  fi

  "$ADB" -s "$serial" shell wm size "${SCREEN_W}x${SCREEN_H}" >/dev/null 2>&1 || true
  "$ADB" -s "$serial" shell wm density "$SCREEN_DPI" >/dev/null 2>&1 || true

  mem_kb="$("$ADB" -s "$serial" shell cat /proc/meminfo 2>/dev/null | awk '/MemTotal/{print $2}')"
  ram_target_kb=$(( RAM_MB * 1024 ))
  if [[ -n "$mem_kb" && "$mem_kb" -lt $(( ram_target_kb * 6 / 10 )) ]]; then
    log "WARNING: ${serial} reports ${mem_kb}kB RAM, well below the ${RAM_MB}MB target."
    log "         config.ini was normalized; cold-boot this AVD (restart) so the new RAM/heap takes effect."
  fi
  log "Emulator ${serial} enforced to ${SCREEN_W}x${SCREEN_H}@${SCREEN_DPI}dpi (RAM/heap/cores set in config.ini + launch flags)"
}

refresh_tools

READY_SERIAL="$(pick_ready_device || true)"
if [[ "$MODE" == "check" ]]; then
  if [[ -n "$READY_SERIAL" ]]; then
    log "Android device is ready: ${READY_SERIAL}"
    state ready "serial=${READY_SERIAL}"
    exit 0
  fi
  if [[ -z "$ADB" || -z "$EMULATOR" ]]; then
    fail 12 missing_android_tools "Android platform-tools or emulator is not installed"
  fi
  if avd_exists; then
    log "AVD ${AVD_NAME} is installed but not running"
    state stopped "avd=${AVD_NAME}"
    exit 10
  fi
  if [[ -n "$SDKMANAGER" && -n "$AVDMANAGER" ]]; then
    log "AVD ${AVD_NAME} is not installed"
    state missing_avd "avd=${AVD_NAME}"
    exit 11
  fi
  fail 12 missing_android_tools "Android command-line tools are not installed"
fi

if [[ -z "$READY_SERIAL" ]]; then
  if [[ -z "$SDKMANAGER" || -z "$AVDMANAGER" ]]; then
    if [[ "$INSTALL_MISSING" != "1" ]]; then
      fail 12 missing_android_tools "Android command-line tools are required to create AVD ${AVD_NAME}"
    fi
    if [[ "$(uname -s)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
      log "Installing Android command-line tools with Homebrew ..."
      brew install --cask android-commandlinetools
      refresh_tools
    fi
    if [[ -z "$SDKMANAGER" || -z "$AVDMANAGER" ]]; then
      fail 12 missing_android_tools "Install Android Studio or Android command-line tools, then retry"
    fi
  fi

  ANDROID_ARCH="$(host_arch)"
  SYSTEM_IMAGE="system-images;android-${ANDROID_API};google_apis;${ANDROID_ARCH}"
  HAS_AVD=0
  if avd_exists; then HAS_AVD=1; fi

  if [[ -z "$ADB" || -z "$EMULATOR" || ( "$HAS_AVD" == "0" && ! -d "${SDK_ROOT}/system-images/android-${ANDROID_API}/google_apis/${ANDROID_ARCH}" ) ]]; then
    if [[ "$INSTALL_MISSING" != "1" ]]; then
      fail 12 missing_android_tools "Android emulator packages are incomplete"
    fi
    mkdir -p "$SDK_ROOT"
    log "Accepting Android SDK licenses for the requested packages ..."
    set +o pipefail
    yes | "$SDKMANAGER" --sdk_root="$SDK_ROOT" --licenses >/dev/null
    set -o pipefail
    PACKAGES=(platform-tools emulator)
    if [[ "$HAS_AVD" == "0" ]]; then
      log "Installing platform-tools, emulator and ${SYSTEM_IMAGE} (this is a multi-GB download) ..."
      PACKAGES+=("$SYSTEM_IMAGE")
    else
      log "Installing missing Android platform-tools/emulator packages ..."
    fi
    "$SDKMANAGER" --sdk_root="$SDK_ROOT" "${PACKAGES[@]}"
    refresh_tools
  fi

  if [[ -z "$ADB" || -z "$EMULATOR" ]]; then
    fail 12 missing_android_tools "Android SDK installation completed without adb/emulator executables"
  fi

  if [[ "$HAS_AVD" == "0" ]]; then
    if [[ "$INSTALL_MISSING" != "1" ]]; then
      fail 11 missing_avd "AVD ${AVD_NAME} is not installed"
    fi
    log "Creating root-capable Google APIs AVD ${AVD_NAME} ..."
    printf 'no\n' | "$AVDMANAGER" create avd \
      --name "$AVD_NAME" \
      --package "$SYSTEM_IMAGE" \
      --device pixel_6
  fi

  normalize_avd_config
  log "Starting AVD ${AVD_NAME} ..."
  EMULATOR_LOG="${TMPDIR:-/tmp}/shortdrama-dl-${AVD_NAME}-emulator.log"
  nohup "$EMULATOR" "@${AVD_NAME}" -no-snapshot -writable-system -gpu auto \
    -memory "$RAM_MB" -cores "$CPU_CORES" \
    >"$EMULATOR_LOG" 2>&1 &

  deadline=$(( $(date +%s) + BOOT_TIMEOUT ))
  while [[ $(date +%s) -lt $deadline ]]; do
    READY_SERIAL="$(pick_ready_device || true)"
    if [[ -n "$READY_SERIAL" ]]; then break; fi
    sleep 2
  done
  if [[ -z "$READY_SERIAL" ]]; then
    fail 14 emulator_start_failed "AVD did not appear in adb within ${BOOT_TIMEOUT}s; see ${EMULATOR_LOG}"
  fi

  log "Waiting for Android to finish booting ..."
  while [[ $(date +%s) -lt $deadline ]]; do
    booted="$("$ADB" -s "$READY_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    if [[ "$booted" == "1" ]]; then break; fi
    sleep 3
  done
  if [[ "${booted:-}" != "1" ]]; then
    fail 15 emulator_boot_timeout "Android did not finish booting within ${BOOT_TIMEOUT}s"
  fi
fi

log "Requesting adb root on ${READY_SERIAL} ..."
"$ADB" -s "$READY_SERIAL" root >/dev/null 2>&1 || true
sleep 2
"$ADB" -s "$READY_SERIAL" wait-for-device

DEVICE_ID="$("$ADB" -s "$READY_SERIAL" shell id 2>/dev/null | tr -d '\r' || true)"
if [[ "$DEVICE_ID" != *"uid=0("* ]]; then
  fail 16 root_required "Device ${READY_SERIAL} is not adb-root capable; use a Google APIs AVD, not a Google Play AVD"
fi

# Normalize config.ini even when we did not start it ourselves, so the next cold
# boot converges; then force runtime resolution/density on emulators.
normalize_avd_config
enforce_runtime_spec "$READY_SERIAL"

FRIDA_PID="$("$ADB" -s "$READY_SERIAL" shell pidof frida-server 2>/dev/null | tr -d '\r' || true)"
if [[ -z "$FRIDA_PID" ]]; then
  if "$ADB" -s "$READY_SERIAL" shell test -x /data/local/tmp/frida-server >/dev/null 2>&1; then
    "$ADB" -s "$READY_SERIAL" shell \
      "nohup /data/local/tmp/frida-server >/dev/null 2>&1 &" >/dev/null 2>&1 || true
    sleep 2
    FRIDA_PID="$("$ADB" -s "$READY_SERIAL" shell pidof frida-server 2>/dev/null | tr -d '\r' || true)"
  fi
fi

if [[ -n "$FRIDA_PID" ]]; then
  log "Ready: ${READY_SERIAL}, root, frida-server pid ${FRIDA_PID}"
else
  log "Ready: ${READY_SERIAL}, root; frida-server will be checked by the Python runtime"
fi
state ready "serial=${READY_SERIAL}"
