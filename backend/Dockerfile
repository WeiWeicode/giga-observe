FROM node:22-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 51202 51203

CMD ["node", "src/index.js"]
