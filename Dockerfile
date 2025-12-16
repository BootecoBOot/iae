FROM node:20-alpine

# Instala dependências necessárias
RUN apk add --no-cache \
    sqlite \
    python3 \
    make \
    g++ \
    wget \
    && rm -rf /var/cache/apk/*

# Cria diretório da aplicação
WORKDIR /app

# Define variáveis de ambiente
ENV NODE_ENV=production\
    PORT=3000

# Copia arquivos de dependência primeiro para melhor cache
COPY package*.json ./

# Instala dependências de produção
RUN npm ci --only=production && \
    # Cria diretórios necessários
    mkdir -p /app/data /app/personas && \
    # Cria usuário não-root
    addgroup -S nodejs && \
    adduser -S nodejs -G nodejs && \
    # Ajusta permissões
    chown -R nodejs:nodejs /app

# Copia o resto da aplicação
COPY --chown=nodejs:nodejs . .

# Copia e configura o entrypoint
COPY --chown=nodejs:nodejs docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Usuário não-root
USER nodejs

# Expõe a porta
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

# Comando de inicialização
ENTRYPOINT ["docker-entrypoint.sh"]

# Comando padrão para rodar a aplicação
CMD ["node", "index.js"]
