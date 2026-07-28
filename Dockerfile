FROM node:20-slim

LABEL org.opencontainers.image.source="https://github.com/deputynl/wetty"
LABEL org.opencontainers.image.description="A persistent SSH terminal in the browser (ttyd + tmux) that survives dropped connections"
LABEL org.opencontainers.image.licenses="MIT"

ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates tmux openssh-client \
    && case "${TARGETARCH}" in \
         amd64) TTYD_ARCH=x86_64 ;; \
         arm64) TTYD_ARCH=aarch64 ;; \
         *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.${TTYD_ARCH}" -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public
COPY tmux.conf /etc/tmux.conf

ENV PORT=8080

EXPOSE 8080
CMD ["node", "server/index.js"]
