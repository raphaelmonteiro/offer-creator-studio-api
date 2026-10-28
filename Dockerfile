FROM node:18-alpine

# ffmpeg é dependência do consumer `render.export` (TDD §6.1), que roda no
# container do worker. A imagem é a mesma para API e worker.
# ttf-dejavu + fontconfig: o drawtext (selos/legendas da montagem) precisa de uma fonte —
# sem isso o ffmpeg falha com "Cannot find a valid font for the family Sans".
#
# Render Remotion (F2 `offer_carousel` / `offer_piece`, MC_CAROUSEL_RENDERER=remotion), que roda no worker:
# - gcompat: o compositor do Remotion (@remotion/compositor-linux-*-musl) é um ELF com interpretador glibc
#   (/lib/ld-linux-aarch64.so.1 ou /lib/ld-linux-x86-64.so.2) que o Alpine não tem. Sem o loader o exec falha com
#   "setpriv: failed to execute .../remotion: No such file or directory" (127), seguido de `write EPIPE` que derruba o worker.
# - chromium + chromium-swiftshader: navegador do render (MC_RENDER_BROWSER=/usr/bin/chromium-browser); sem o swiftshader
#   (GL por software) o render pendura em container sem GPU.
# - setpriv: `setpriv` completo em /usr/bin; o do BusyBox não tem `--pdeathsig` e o Remotion lança o Chromium
#   por ele ("setpriv: unrecognized option: pdeathsig" => "Failed to launch the browser process").
# - shim do launcher do Chromium: o Remotion 4.0.x abre o navegador com `--headless=old`, removido do Chromium completo >= 132
#   ("Old Headless mode has been removed from the Chrome binary", runbook deploy-commercials-producao.md, bloqueio B1). Aqui o
#   launcher reescreve `--headless=old` para `--headless=new`; só vale para o ambiente local (em produção o navegador é o
#   chrome-headless-shell do checkout do pacote, que aceita o modo).
# NODE_OPTIONS=--dns-result-order=ipv4first fica no serviço `worker` do docker-compose.yml (corrigir-render-remotion-epipe, P-40).
RUN apk add --no-cache ffmpeg ttf-dejavu fontconfig gcompat chromium chromium-swiftshader setpriv
RUN sed -i 's|^exec "\$PROGDIR/chromium"|for a in "\$@"; do shift; [ "\$a" = "--headless=old" ] \&\& a="--headless=new"; set -- "\$@" "\$a"; done\n&|' /usr/lib/chromium/chromium-launcher.sh \
 && grep -q 'headless=new' /usr/lib/chromium/chromium-launcher.sh

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3001

CMD ["npm", "run", "dev"]
