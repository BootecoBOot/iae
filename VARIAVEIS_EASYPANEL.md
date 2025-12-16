# 🚀 GUIA RÁPIDO - Adicionar Variáveis no EasyPanel

## ✅ Suas Variáveis de Ambiente (COPIE ESTAS LINHAS):

```
EVOLUTION_URL=https://iaatende-evolution-api.agu3wx.easypanel.host
EVOLUTION_API_KEY=5E42A2CA0527-4104-AADD-7A55C88EAD3E
INSTANCE=iae
GOOGLE_MAPS_API_KEY=AIzaSyDRNopRLdVdUv17AuxMsbbhpEU2ejLIM1I
GEMINI_API_KEY=AIzaSyA519FQsjr0RJVaKNlN_bU_HJu-UMGgEQs
PORT=3000
```

## 📋 PASSO A PASSO NO EASYPANEL:

### 1. Acesse seu Serviço
- Vá para o painel do EasyPanel
- Clique no seu serviço IAE
- Vá para a aba "Environment" ou "Variáveis de Ambiente"

### 2. Adicione as Variáveis
- **Clique em "Add Variable" ou "Adicionar Variável"**
- **Adicione UMA POR VEZ:**

| Nome da Variável | Valor |
|------------------|-------|
| `EVOLUTION_URL` | `https://iaatende-evolution-api.agu3wx.easypanel.host` |
| `EVOLUTION_API_KEY` | `5E42A2CA0527-4104-AADD-7A55C88EAD3E` |
| `INSTANCE` | `iae` |
| `GOOGLE_MAPS_API_KEY` | `AIzaSyDRNopRLdVdUv17AuxMsbbhpEU2ejLIM1I` |
| `GEMINI_API_KEY` | `AIzaSyA519FQsjr0RJVaKNlN_bU_HJu-UMGgEQs` |
| `PORT` | `3000` |

### 3. Salve e Deploy
- **Clique em "Save" ou "Salvar"**
- **Clique em "Deploy" ou "Redeploy"**
- **Aguarde 2-3 minutos** para o container iniciar

## ✅ VERIFICAÇÃO
Após o deploy, acesse: `https://seu-dominio-easypanel:3000/health`

Deve retornar:
```json
{"status":"ok","timestamp":"2025-...","uptime":...}
```

## 🚨 IMPORTANTE:
- **NÃO** copie o arquivo `.env` diretamente
- **ADICIONE UMA VARIÁVEL POR VEZ** no painel
- **AGUARDE** o container reiniciar completamente
- **VERIFIQUE OS LOGS** se houver algum erro

## 🔍 SE TIVER ERROS:
1. Verifique se copiou os valores corretamente
2. Confirme que não há espaços extras
3. Verifique os logs do container
4. Certifique-se que a Evolution API está funcionando