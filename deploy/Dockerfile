FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY config ./config
COPY skins ./skins
COPY datasets ./datasets
ENV AAF_ENV=hosted AAF_BIND=0.0.0.0 NODE_OPTIONS=--disable-warning=ExperimentalWarning
USER node
