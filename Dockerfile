FROM node:20-bullseye-slim

WORKDIR /app

# Copiar package.json y package-lock.json
COPY package*.json ./

# Instalar dependencias
RUN npm install --production

# Copiar el resto del código
COPY . .

# Definir puerto
ENV PORT=8080
EXPOSE $PORT

# Iniciar la aplicación
CMD ["node", "server.js"]
