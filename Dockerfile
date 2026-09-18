FROM node:18-alpine

# ffmpeg é dependência do consumer `render.export` (TDD §6.1), que roda no
# container do worker. A imagem é a mesma para API e worker.
# ttf-dejavu + fontconfig: o drawtext (selos/legendas da montagem) precisa de uma fonte —
# sem isso o ffmpeg falha com "Cannot find a valid font for the family Sans".
RUN apk add --no-cache ffmpeg ttf-dejavu fontconfig

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3001

CMD ["npm", "run", "dev"]
