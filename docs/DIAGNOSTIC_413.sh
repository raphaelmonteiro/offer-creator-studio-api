#!/bin/bash

echo "=========================================="
echo "DIAGNÓSTICO - Erro 413 Request Entity Too Large"
echo "=========================================="
echo ""

echo "1. Verificando configuração do Nginx..."
echo "----------------------------------------"
if sudo grep -q "client_max_body_size" /etc/nginx/sites-available/default; then
    echo "✅ client_max_body_size encontrado:"
    sudo grep "client_max_body_size" /etc/nginx/sites-available/default
else
    echo "❌ client_max_body_size NÃO encontrado!"
fi
echo ""

echo "2. Verificando se Nginx está rodando..."
echo "----------------------------------------"
if systemctl is-active --quiet nginx; then
    echo "✅ Nginx está rodando"
    sudo nginx -t 2>&1 | head -5
else
    echo "❌ Nginx NÃO está rodando!"
fi
echo ""

echo "3. Verificando PM2..."
echo "----------------------------------------"
if pm2 list | grep -q "flyer-api"; then
    echo "✅ Aplicação encontrada no PM2:"
    pm2 list | grep "flyer-api"
    echo ""
    echo "Status detalhado:"
    pm2 describe flyer-api | grep -E "status|uptime|restarts"
else
    echo "❌ Aplicação NÃO encontrada no PM2!"
fi
echo ""

echo "4. Verificando se o código foi compilado..."
echo "----------------------------------------"
if [ -f "/opt/mvp-encarte-v2/offer-creator-studio-api/dist/main.js" ]; then
    echo "✅ Arquivo compilado existe"
    echo "Data de modificação:"
    ls -lh /opt/mvp-encarte-v2/offer-creator-studio-api/dist/main.js | awk '{print $6, $7, $8}'
    
    echo ""
    echo "Verificando se contém os limites aumentados:"
    if grep -q "100mb\|100MB" /opt/mvp-encarte-v2/offer-creator-studio-api/dist/main.js 2>/dev/null; then
        echo "✅ Limites de 100MB encontrados no código compilado"
    else
        echo "⚠️  Limites de 100MB NÃO encontrados - código pode estar desatualizado"
    fi
else
    echo "❌ Arquivo compilado NÃO existe!"
fi
echo ""

echo "5. Verificando se a aplicação responde..."
echo "----------------------------------------"
if curl -s http://localhost:3001/v1/health > /dev/null 2>&1; then
    echo "✅ Aplicação responde na porta 3001"
    curl -s http://localhost:3001/v1/health | head -3
else
    echo "❌ Aplicação NÃO responde na porta 3001!"
fi
echo ""

echo "6. Verificando se Nginx está fazendo proxy..."
echo "----------------------------------------"
if curl -s http://localhost/api/v1/health > /dev/null 2>&1; then
    echo "✅ Nginx está fazendo proxy corretamente"
    curl -s http://localhost/api/v1/health | head -3
else
    echo "❌ Nginx NÃO está fazendo proxy!"
fi
echo ""

echo "7. Últimos erros do Nginx..."
echo "----------------------------------------"
sudo tail -5 /var/log/nginx/error.log 2>/dev/null || echo "Nenhum erro recente"
echo ""

echo "8. Últimas linhas do PM2..."
echo "----------------------------------------"
pm2 logs flyer-api --lines 5 --nostream 2>/dev/null || echo "Nenhum log disponível"
echo ""

echo "=========================================="
echo "FIM DO DIAGNÓSTICO"
echo "=========================================="
