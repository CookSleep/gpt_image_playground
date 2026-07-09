FROM node:20-alpine

WORKDIR /app

COPY backend/scripts/mock-openai-compatible.mjs ./mock-openai-compatible.mjs

EXPOSE 4010

CMD ["node", "mock-openai-compatible.mjs"]

