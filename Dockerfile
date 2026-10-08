FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
ENV PORT=8787
EXPOSE 8787
CMD ["node", "src/serveur-node.js"]
