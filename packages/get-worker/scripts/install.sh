#!/usr/bin/env bash
# OmO native installer: curl -fsSL https://get.omo.dev/install.sh | bash [-s -- latest|beta|X.Y.Z]
#   OMO_INSTALL_DIR        launcher directory (default ~/.local/bin)
#   OMO_NO_MODIFY_PATH=1   never edit shell profiles
#   OMO_INSTALL_BASE_URL   mirror base (default https://get.omo.dev); GitHub is the fallback
#   OMO_INSTALL_ALLOW_SUDO=1  allow running as root
# The whole body runs from main() on the last line, so a truncated download never runs half a script.
set -euo pipefail

REPO="code-yeongyu/oh-my-openagent"
GITHUB_DOWNLOAD="https://github.com/${REPO}/releases/download"
NPM_DIST_TAGS="https://registry.npmjs.org/-/package/omo-ai/dist-tags"
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$'
MARK_BEGIN="# >>> omo installer >>>"
MARK_END="# <<< omo installer <<<"
USER_AGENT="omo-install.sh/1"
[ "${OMO_INSTALL_QA:-}" = 1 ] && USER_AGENT="${USER_AGENT} omo-install-qa" # QA runs stay out of the public count

say() { printf '%s\n' "$*" >&2; }
fail() { say "omo installer: $*"; exit 1; }

fetch() { # fetch <url> <output file|->
  if command -v curl >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -fsSL --retry 2 --connect-timeout 15 -A "$USER_AGENT" -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --https-only -U "$USER_AGENT" -O "$2" "$1"
  else
    fail "curl or wget is required"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | awk '{print $NF}'
  else fail "sha256sum, shasum or openssl is required to verify the download"
  fi
}

detect_asset() {
  local os arch libc="" cpu=""
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN*) fail "on Windows run in PowerShell: irm https://get.omo.dev/install.ps1 | iex" ;;
    *) fail "unsupported operating system $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "unsupported architecture $(uname -m)" ;;
  esac
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64 # a Rosetta shell on Apple silicon gets the native build
  fi
  if [ "$os" = linux ]; then
    if [ -f /etc/alpine-release ] || ls /lib/ld-musl-*.so.1 >/dev/null 2>&1 || (ldd --version 2>&1 | grep -qi musl); then
      libc="-musl"
    fi
  fi
  if [ "$arch" = x64 ]; then
    if [ "$os" = linux ] && ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then cpu="-baseline"; fi
    if [ "$os" = darwin ] && [ "$(sysctl -n hw.optional.avx2_0 2>/dev/null || echo 0)" != 1 ]; then cpu="-baseline"; fi
  fi
  printf 'omo-%s-%s%s%s\n' "$os" "$arch" "$libc" "$cpu"
}

resolve_version() { # resolve_version <latest|beta|X.Y.Z> <base url>
  local want="$1" base="$2" got=""
  if [[ "$want" =~ $VERSION_RE ]]; then printf '%s\n' "$want"; return; fi
  got="$(fetch "${base}/channels/${want}" - 2>/dev/null | tr -d '[:space:]' || true)"
  if ! [[ "$got" =~ $VERSION_RE ]]; then
    say "  ${base} did not answer for channel ${want}; asking the npm registry"
    got="$(fetch "$NPM_DIST_TAGS" - 2>/dev/null | tr -d '[:space:]' | sed -n "s/.*\"${want}\":\"\([^\"]*\)\".*/\1/p" || true)"
    got="${got/-0./-}"
  fi
  [[ "$got" =~ $VERSION_RE ]] || fail "could not resolve the ${want} channel (mirror and npm registry both failed)"
  printf '%s\n' "$got"
}

download() { # download <version> <asset> <dest> <base>: mirror first, GitHub release asset second
  if fetch "${4}/v/${1}/${2}" "$3" 2>/dev/null; then return 0; fi
  say "  mirror download of ${2} failed; falling back to GitHub releases"
  fetch "${GITHUB_DOWNLOAD}/v${1}/${2}" "$3" || fail "could not download ${2} ${1} from the mirror or GitHub"
}

profile_file() {
  case "$(basename "${SHELL:-sh}")" in
    zsh) printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) if [ "$(uname -s)" = Darwin ]; then printf '%s\n' "$HOME/.bash_profile"; else printf '%s\n' "$HOME/.bashrc"; fi ;;
    fish) printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/omo.fish" ;;
    *) printf '%s\n' "$HOME/.profile" ;;
  esac
}

ensure_path() { # ensure_path <dir>; prints the edited profile, or nothing
  local dir="$1" profile line tmp
  case ":${PATH}:" in *":${dir}:"*) return 0 ;; esac
  if [ -n "${GITHUB_PATH:-}" ]; then printf '%s\n' "$dir" >>"$GITHUB_PATH"; fi
  [ "${OMO_NO_MODIFY_PATH:-}" = 1 ] && return 0
  profile="$(profile_file)"
  if [[ "$profile" == *.fish ]]; then line="fish_add_path -g \"${dir}\""; else line="export PATH=\"${dir}:\$PATH\""; fi
  mkdir -p "$(dirname "$profile")"
  touch "$profile"
  tmp="$(mktemp "${profile}.omo.XXXXXX")"
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '$0==b{skip=1;next} $0==e{skip=0;next} !skip' "$profile" >"$tmp"
  printf '%s\n%s\n%s\n' "$MARK_BEGIN" "$line" "$MARK_END" >>"$tmp"
  cat "$tmp" >"$profile" && rm -f "$tmp"
  printf '%s\n' "$profile"
}

report_other_installs() { # report_other_installs <launcher>
  local launcher="$1" first="" candidate real owner=""
  first="$(command -v omo 2>/dev/null || true)"
  while IFS= read -r candidate; do
    if [ -z "$candidate" ] || [ "$candidate" = "$launcher" ]; then continue; fi
    real="$(readlink -f "$candidate" 2>/dev/null || printf '%s' "$candidate")"
    case "$real" in
      */node_modules/omo-ai/*) owner="omo-ai (npm or bun global install)" ;;
      */node_modules/oh-my-opencode/* | */node_modules/oh-my-openagent/*) owner="the legacy oh-my-openagent package" ;;
      *) owner="another omo binary" ;;
    esac
    say ""
    say "Note: ${candidate} is ${owner}."
    if [ "$first" = "$candidate" ]; then
      say "  It comes first on PATH, so typing 'omo' still runs it instead of ${launcher}."
    else
      say "  ${launcher} comes first on PATH; that one is not used."
    fi
    case "$owner" in
      omo-ai*) say "  Nothing was removed. To keep only this install: bun remove -g omo-ai  (or: npm uninstall -g omo-ai)" ;;
      *) say "  Nothing was removed. Remove it yourself if you no longer need it." ;;
    esac
  done < <(type -ap omo 2>/dev/null | awk '!seen[$0]++')
}

write_receipt() { # write_receipt <channel> <version> <asset> <launcher> <profile>
  mkdir -p "$HOME/.omo"
  local tmp
  tmp="$(mktemp "$HOME/.omo/install.json.XXXXXX")"
  printf '{\n  "method": "standalone",\n  "channel": "%s",\n  "version": "%s",\n  "asset": "%s",\n  "binPath": "%s",\n  "profileEdits": [%s],\n  "installedAt": "%s"\n}\n' \
    "$1" "$2" "$3" "$4" "${5:+\"$5\"}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$tmp"
  mv -f "$tmp" "$HOME/.omo/install.json"
}

main() {
  local want="${1:-latest}" base="${OMO_INSTALL_BASE_URL:-https://get.omo.dev}"
  base="${base%/}"
  case "$want" in latest | beta) ;; *) [[ "$want" =~ $VERSION_RE ]] || fail "usage: install.sh [latest|beta|X.Y.Z]" ;; esac
  if [ "$(id -u)" = 0 ] && [ "${OMO_INSTALL_ALLOW_SUDO:-}" != 1 ]; then
    fail "refusing to run as root; run it as your user (set OMO_INSTALL_ALLOW_SUDO=1 to override)"
  fi
  [ -n "${HOME:-}" ] || fail "HOME is not set"

  local asset version dir launcher work expected actual profile channel
  asset="$(detect_asset)"
  version="$(resolve_version "$want" "$base")"
  channel="$want"; [[ "$want" =~ $VERSION_RE ]] && channel="pinned"
  dir="${OMO_INSTALL_DIR:-$HOME/.local/bin}"
  launcher="${dir}/omo"
  say "Installing omo ${version} (${asset}) into ${dir}"

  work="$(mktemp -d "${TMPDIR:-/tmp}/omo-install.XXXXXX")"
  # shellcheck disable=SC2064 # expand now: the local is gone when the EXIT trap fires after main returns
  trap "rm -rf '${work}'" EXIT
  download "$version" SHA256SUMS "$work/SHA256SUMS" "$base"
  expected="$(awk -v a="$asset" '$2==a || $2=="*"a {print $1}' "$work/SHA256SUMS" | head -n1)"
  [ -n "$expected" ] || fail "SHA256SUMS for ${version} has no entry for ${asset}"

  if [ -x "$launcher" ] && [ "$(sha256_of "$launcher")" = "$expected" ]; then
    say "  omo ${version} is already installed at ${launcher}"
  else
    download "$version" "$asset" "$work/omo" "$base"
    actual="$(sha256_of "$work/omo")"
    [ "$actual" = "$expected" ] || fail "checksum mismatch for ${asset}: expected ${expected}, got ${actual}"
    say "  checksum verified (sha256 ${expected})"
    chmod +x "$work/omo"
    mkdir -p "$dir"
    cp "$work/omo" "${launcher}.new.$$"
    mv -f "${launcher}.new.$$" "$launcher"
  fi

  if [ "${asset#*-musl}" != "$asset" ] && ! ls /usr/lib/libstdc++.so.6 /lib/libstdc++.so.6 >/dev/null 2>&1; then
    say "  musl build needs libstdc++: apk add libstdc++ libgcc"
  fi
  "$launcher" --version >&2 || fail "${launcher} --version failed"

  profile="$(ensure_path "$dir")"
  write_receipt "$channel" "$version" "$asset" "$launcher" "$profile"
  report_other_installs "$launcher"
  say ""
  say "omo ${version} is installed at ${launcher}."
  if [ -n "$profile" ]; then
    say "${profile} puts ${dir} on PATH; open a new shell (or run: export PATH=\"${dir}:\$PATH\") and run: omo"
  else
    say "Run: omo"
  fi
}

main "$@"
