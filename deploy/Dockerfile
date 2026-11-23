# Built from the repository root:
#   docker buildx build --platform linux/amd64 -f deploy/Dockerfile -t aaf-osfi:<short commit> --load .
FROM node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
WORKDIR /app
COPY package.json package-lock.json ./
# /data is created for the unprivileged user so a fresh volume is writable.
RUN npm ci --omit=dev && install -d -o node -g node -m 0700 /data
COPY src ./src
COPY config ./config
COPY skins ./skins
COPY datasets ./datasets
ENV AAF_ENV=hosted AAF_BIND=0.0.0.0 NODE_OPTIONS=--disable-warning=ExperimentalWarning
USER node
