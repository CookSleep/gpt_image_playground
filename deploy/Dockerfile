# ---- Build stage ----
# Alpine + npm ci 在 Rollup optional native package 上经常丢依赖，改用 glibc 基础镜像规避。
FROM node:20-bookworm-slim AS build

WORKDIR /app
ARG TARGETARCH

ENV VITE_DEFAULT_API_URL=__VITE_DEFAULT_API_URL_PLACEHOLDER__

COPY package.json package-lock.json ./
RUN npm ci
RUN case "$TARGETARCH" in \
    "amd64") npm install --no-save @rollup/rollup-linux-x64-gnu ;; \
    "arm64") npm install --no-save @rollup/rollup-linux-arm64-gnu ;; \
    *) echo "Unsupported TARGETARCH: $TARGETARCH" && exit 1 ;; \
    esac

COPY . .
RUN npm run build

# ---- Production stage ----
FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/inject-api-url.sh /docker-entrypoint.d/40-inject-api-url.sh
RUN chmod +x /docker-entrypoint.d/40-inject-api-url.sh

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
