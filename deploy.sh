#!/bin/bash
#
# Deploy de produção do backend (NestJS) na VM.
# O backend roda via pm2 (processo "flyer-api"), executando dist/main.js com node.
# Este script: atualiza o código (git), instala deps (INCL. devDeps, necessárias p/ buildar),
# builda (nest build → dist/) e reinicia o pm2.
#
# Uso na VM:   ./deploy.sh            (roda como o dono do repo via sudo -u; é quem tem a chave SSH do GitHub)
# Forçar:      FORCE=1 ./deploy.sh    (descarta mudanças locais do repo na VM)
# Variáveis:   PM2_APP (default flyer-api), BRANCH (default main)
#
set -euo pipefail

# Roda como o DONO do repo (tem a chave SSH do GitHub e é quem roda o pm2).
# Rodar como root quebraria o git (root não tem a chave SSH do GitHub).
OWNER="$(stat -c '%U' "$0" 2>/dev/null || echo "$(id -un)")"
if [ "$(id -un)" != "$OWNER" ]; then
  echo "🔑 Rodando como o dono do repo ($OWNER)..."
  exec sudo -u "$OWNER" -H bash "$0" "$@"
fi

REPO="$(cd "$(dirname "$0")" && pwd)"
PM2_APP="${PM2_APP:-flyer-api}"
BRANCH="${BRANCH:-main}"

echo "🚀 Deploy do backend (pm2: $PM2_APP)"
echo "   repo: $REPO"
echo ""

git config --global --add safe.directory "$REPO" 2>/dev/null || true
cd "$REPO"

echo "⬇️  Atualizando código (origin/$BRANCH)..."
git fetch --quiet origin "$BRANCH"
if [ "${FORCE:-0}" = "1" ]; then
  git reset --hard "origin/$BRANCH"
else
  git checkout "$BRANCH"
  git merge --ff-only "origin/$BRANCH" || {
    echo "⚠️  Sem fast-forward (mudanças locais/divergência). Rode 'FORCE=1 ./deploy.sh' para forçar."
    exit 1
  }
fi
echo "   ✓ $(git log --oneline -1)"
echo ""

# devDeps são necessárias pro build (nest/@nestjs/cli são devDependencies).
# --include=dev força mesmo se o ambiente tiver NODE_ENV=production. npm install é aditivo
# (não apaga node_modules) — mais seguro pra um backend que está no ar do que npm ci.
echo "📦 Instalando dependências (incluindo devDeps p/ o build)..."
npm install --include=dev --no-audit --no-fund
echo ""

echo "🔨 Build (nest build → dist/)..."
npm run build
[ -f dist/main.js ] || { echo "❌ Build falhou: dist/main.js não foi gerado."; exit 1; }
echo "   ✓ dist/main.js atualizado"
echo ""

echo "♻️  Reiniciando o pm2 ($PM2_APP)..."
pm2 restart "$PM2_APP" --update-env
sleep 4
pm2 list | grep -E "name|$PM2_APP" || true
echo ""

echo "✅ Backend deployado. Cheque a saúde:  curl -s http://127.0.0.1:3001/v1/health"
echo ""
echo "⚠️  ATENÇÃO — schema do banco:"
echo "    O runtime é NODE_ENV=production (o pm2 sobrepõe o .env) → 'synchronize' está DESLIGADO."
echo "    Mudanças de coluna/tabela NÃO se criam sozinhas no restart. Quando uma entidade ganhar"
echo "    colunas novas, rode o SQL/migration manualmente, ex.:"
echo "      ALTER TABLE clients ADD COLUMN IF NOT EXISTS <coluna> <tipo>;"
