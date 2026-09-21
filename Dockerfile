# Super Sinky has no npm dependencies, so there is nothing to install and no
# build step - the image is just Node plus the source.
FROM node:22-alpine

WORKDIR /app
COPY . .

ENV PORT=3000
EXPOSE 3000

# Run unprivileged; the node image ships a `node` user for exactly this.
USER node

CMD ["node", "server/index.js"]
