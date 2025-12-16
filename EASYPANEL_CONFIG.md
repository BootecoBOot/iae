# Configuração para EasyPanel

## Variáveis de Ambiente Obrigatórias

Para funcionar corretamente, você precisa configurar estas variáveis no EasyPanel:

### Evolution API (Obrigatório)
- `EVOLUTION_URL`: URL da sua Evolution API (ex: https://sua-evolution.com)
- `EVOLUTION_API_KEY`: Chave API da Evolution
- `INSTANCE`: Nome da instância WhatsApp na Evolution

### Google APIs (Obrigatório)
- `GOOGLE_MAPS_API_KEY`: Chave do Google Maps Platform
- `GEMINI_API_KEY`: Chave do Google Gemini AI

### Opcionais
- `PORT`: Porta do servidor (padrão: 3000)
- `NODE_ENV`: Ambiente (padrão: production)
- `GEMINI_MODEL`: Modelo Gemini (padrão: gemini-2.5-flash)
- `GEMINI_TEMPERATURE`: Temperatura do modelo (padrão: 0.2)

## Como configurar no EasyPanel

1. Crie um novo serviço com tipo "Dockerfile"
2. Configure as variáveis de ambiente acima
3. A porta exposta deve ser 3000
4. O healthcheck está configurado em /health

## Debug

Se o container não iniciar, verifique os logs para ver se falta alguma variável obrigatória.