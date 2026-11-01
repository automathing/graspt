#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${ROOT_DIR}/extension"
LEAN_DIR="${ROOT_DIR}/lean"

link_extension() {
  for dir in "${HOME}/.vscode-remote/extensions" "${HOME}/.vscode-server/extensions"; do
    mkdir -p "${dir}"
    ln -sfn "${EXT_DIR}" "${dir}/graspt.graspt-0.1.0"
  done
}

if [[ "${1:-}" == "--link-only" ]]; then
  link_extension
  exit 0
fi

echo "==> [1/5] Installing system utilities (zstd, lz4, jq, btop, fastfetch)..."
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    curl git zstd lz4 jq btop fastfetch ca-certificates >/dev/null
fi

echo "==> [2/5] Installing elan + Lean 4 toolchain (leanprover/lean4:v4.36.0-rc2)..."
if [[ ! -x "${HOME}/.elan/bin/elan" ]]; then
  curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | \
    sh -s -- -y --default-toolchain leanprover/lean4:v4.36.0-rc2
fi
export PATH="${HOME}/.elan/bin:${PATH}"
if ! grep -q '\.elan/bin' "${HOME}/.bashrc" 2>/dev/null; then
  echo 'export PATH="$HOME/.elan/bin:$PATH"' >> "${HOME}/.bashrc"
fi
if ! grep -q '\.elan/bin' "${HOME}/.profile" 2>/dev/null; then
  echo 'export PATH="$HOME/.elan/bin:$PATH"' >> "${HOME}/.profile"
fi

echo "==> [3/5] Installing pi coding agent (@earendil-works/pi-coding-agent) & Meta Muse defaults..."
if ! command -v pi >/dev/null 2>&1; then
  npm install -g @earendil-works/pi-coding-agent
fi
mkdir -p "${HOME}/.pi/agent"
if [[ ! -f "${HOME}/.pi/agent/settings.json" ]]; then
  cat > "${HOME}/.pi/agent/settings.json" <<'EOF'
{
  "defaultProvider": "meta",
  "defaultModel": "muse-spark-1.3"
}
EOF
fi

echo "==> [4/5] Fetching Mathlib cache & building graspt-trace, graspt-atlas, and Demo..."
cd "${LEAN_DIR}"
lake exe cache get
lake build graspt-trace graspt-atlas Demo
if [[ ! -f "${LEAN_DIR}/.graspt/atlas/atlas.json" ]]; then
  lake exe graspt-atlas
fi

echo "==> [5/5] Building Graspt VS Code extension & linking into VS Code..."
cd "${EXT_DIR}"
npm ci
npm run typecheck
npm run build
link_extension

echo "✅ Graspt reproducible environment ready!"
echo "   - Open 'lean/Demo/LocalLayout.lean' or 'lean/Demo/Basics.lean'"
echo "   - Run 'Graspt: Open Proof Map' in VS Code"
echo "   - Click '🔑 Meta Muse Key' to set your META_API_KEY for pi"
