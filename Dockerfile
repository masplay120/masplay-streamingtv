FROM node:20-bullseye-slim

WORKDIR /app

# Instalar dependencias
COPY package*.json ./
RUN npm install --production

# Copiar el resto del código
COPY . .

EXPOSE 8080

CMD ["npm", "start"]