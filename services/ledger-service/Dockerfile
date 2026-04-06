FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["sh", "-c", "node src/utils/migrate.js && node src/index.js"]
