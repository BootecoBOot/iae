# 🚀 Guia de Configuração EasyPanel para I.aê Bot

## 📋 Pré-requisitos
Antes de começar, você precisa ter:
- Conta no EasyPanel
- Chaves de API configuradas
- Repositório com o código do bot

## 🔑 Variáveis de Ambiente Obrigatórias

### Evolution API
```
EVOLUTION_URL=https://sua-evolution-api.com
EVOLUTION_API_KEY=sua-chave-api-aqui
INSTANCE=nome-da-instancia
```

### Google APIs
```
GOOGLE_MAPS_API_KEY=sua-chave-google-maps-aqui
GEMINI_API_KEY=sua-chave-gemini-aqui
```

## 🐳 Configuração no EasyPanel

### 1. Preparar o Repositório
Certifique-se de que todos os arquivos necessários estão no seu repositório:
- `Dockerfile`
- `docker-entrypoint.sh`
- `package.json`
- `index.js` e outros arquivos do projeto
- `.dockerignore` (evita conflitos)

### 2. Criar Serviço
1. Acesse seu painel EasyPanel
2. Clique em "New Service"
3. Escolha "Docker Compose"
4. Cole o conteúdo do arquivo `easypanel.yml`

### 2. Configurar Variáveis
1. Na aba "Environment", adicione todas as variáveis obrigatórias
2. Substitua os valores com suas chaves reais
3. Salve as configurações

### 3. Configurar Porta
- Porta exposta: `3000`
- Health check: `http://localhost:3000/health`

### 4. Deploy
1. Clique em "Deploy"
2. Aguarde o build e inicialização
3. Verifique os logs para confirmar sucesso

## 🔧 Solução de Problemas

### Container não inicia
- Verifique se todas as variáveis obrigatórias estão configuradas
- Confira os logs do container
- Certifique-se de que as chaves de API são válidas

### Health check falha
- Aguarde 40 segundos (tempo de startup)
- Verifique se a porta 3000 está exposta corretamente
- Confira se o health check está acessível

### Erro "No such image"
- O EasyPanel deve buildar a imagem automaticamente
- Verifique se o Dockerfile está presente no repositório
- Certifique-se de que o build não falhou

## 📁 Estrutura de Arquivos Necessária
```
├── Dockerfile
├── docker-entrypoint.sh
├── easypanel.yml
├── index.js
├── package.json
├── db.js
├── metrics.js
├── personas/ (diretório)
└── data/ (diretório)
```

## ✅ Verificação Final
Após deploy bem-sucedido:
1. Acesse: `http://seu-dominio:3000/health`
2. Deve retornar: `{"status":"ok","timestamp":"...","uptime":...}`
3. Configure webhook Evolution API para: `http://seu-dominio:3000/webhook/evolution`

## 📞 Suporte
Se ainda tiver problemas:
1. Verifique os logs completos do container
2. Confirme que todas as APIs externas estão acessíveis
3. Teste localmente antes do deploy no EasyPanel