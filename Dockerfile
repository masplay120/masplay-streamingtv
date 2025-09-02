# Imagen base
FROM node:20-bullseye-slim

# Crear y establecer directorio de trabajo
WORKDIR /app

# Copiar package.json y package-lock.json (si existe)
COPY package*.json ./

# Instalar dependencias en modo producción
RUN npm install --production

# Copiar el resto del código
COPY . .

# Definir variable de entorno de puerto (Fly.io la usa automáticamente)
ENV PORT=8080
EXPOSE $PORT

# Comando para iniciar la aplicación
CMD ["node", "server.js"]
