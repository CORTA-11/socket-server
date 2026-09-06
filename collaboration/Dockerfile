FROM node:22.22.1-alpine3.22 AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.22.1-alpine3.22 AS production-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22.22.1-alpine3.22

ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY package.json ./

USER node
EXPOSE 8082

HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "const p=process.env.COLLABORATION_PORT??'8082';fetch('http://127.0.0.1:'+p+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/src/main.js"]
