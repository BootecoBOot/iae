# 🚨 CORRIGIR CONFIGURAÇÃO DO WEBHOOK

## ❌ Problema Identificado:
Você configurou o webhook na Evolution API apenas com a URL base: `https://iae-iae.agu3wx.easypanel.host/`

## ✅ Solução Correta:
O endpoint do webhook no seu bot é `/webhook` (não apenas a raiz `/`)

## 📋 Passo a Passo para Corrigir:

### 1. Acesse sua Evolution API
- Abra a URL da sua Evolution API: `https://iaatende-evolution-api.agu3wx.easypanel.host`
- Faça login (se necessário)

### 2. Configure o Webhook Corretamente
- Vá para as configurações da instância `iae`
- **URL do Webhook deve ser:** `https://iae-iae.agu3wx.easypanel.host/webhook`
- **Método:** POST
- **Ativo:** Sim

### 3. Teste a Conexão
Após configurar, teste enviando uma mensagem no WhatsApp. O bot deve responder.

## 🔍 Verificação Rápida:
1. Acesse: `https://iae-iae.agu3wx.easypanel.host/health`
   - Deve retornar: `{"status":"ok","timestamp":"...","uptime":...}`

2. Teste o endpoint do webhook:
   ```bash
   curl -X POST https://iae-iae.agu3wx.easypanel.host/webhook \
     -H "Content-Type: application/json" \
     -d '{"event":"test","data":{"key":{"remoteJid":"test"}}}'
   ```

## 🎯 URLs Importantes:
- **Health Check:** `https://iae-iae.agu3wx.easypanel.host/health`
- **Webhook:** `https://iae-iae.agu3wx.easypanel.host/webhook`
- **Evolution API:** `https://iaatende-evolution-api.agu3wx.easypanel.host`

## ⚠️ Importante:
- O webhook **DEVE** ter `/webhook` no final da URL
- A Evolution API precisa conseguir acessar essa URL
- Verifique os logs do container se ainda não funcionar