FROM node:18-alpine

# Crear carpeta de la app
WORKDIR /usr/src/app

# Copiar dependencias
COPY package*.json ./

# Instalar dependencias
RUN npm install --only=production

# Copiar el resto del código
COPY . .

# Exponer el puerto (Fly usará el 8080 por defecto)
EXPOSE 8080

# Ejecutar la app
CMD ["npm", "start"]
