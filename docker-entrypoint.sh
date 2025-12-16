#!/bin/sh
# Script de inicialização para Docker - I.aê Bot

echo "🚀 Iniciando I.aê Bot..."

# Aguarda um momento para garantir que tudo está pronto
echo "⏳ Aguardando inicialização..."
sleep 5

# Cria diretórios necessários se não existirem (sem admin)
mkdir -p data personas

# Verifica se os arquivos necessários existem
if [ ! -f "index.js" ]; then
    echo "❌ Arquivo index.js não encontrado!"
    ls -la
    exit 1
fi

# Verifica se o Node.js está disponível
if ! command -v node >/dev/null 2>&1; then
    echo "❌ Node.js não encontrado!"
    exit 1
fi

# Mostra informações de debug
echo "📁 Conteúdo do diretório:"
ls -la

echo "🔧 Versão do Node.js:"
node --version

# Inicia a aplicação
echo "✅ Iniciando aplicação..."
exec node index.js