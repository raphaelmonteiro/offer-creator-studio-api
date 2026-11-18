import { NestExpressApplication } from '@nestjs/platform-express';

/** Prefixo público dos arquivos enviados (`<UPLOAD_DEST>/<pasta>/<arquivo>` vira `/uploads/<pasta>/<arquivo>`). */
const UPLOADS_URL_PREFIX = '/uploads/';

/**
 * Serve a pasta de uploads em `/uploads/`, sem autenticação, com os três cabeçalhos de CORS abaixo. É a mesma
 * montagem do `main.ts` e do app de teste do e2e (`createE2eApp` com `serveUploads`).
 *
 * CORS note: `app.enableCors()` só registra um middleware na frente das rotas do Nest; ele não vale para os
 * arquivos que o `express.static` serve. Sem estes cabeçalhos o navegador ainda carrega imagens em `<img>`, mas
 * `fetch(url)` e `<canvas>` lendo-as ficam bloqueados. O fluxo de arte social rasteriza os arquivos enviados com
 * `html-to-image` (que usa canvas), então o CORS em `/uploads/*` é obrigatório ali; o Encarte Pro também carrega as
 * fontes enviadas por `FontFace`, de outra origem.
 */
export function useUploadsStatic(app: NestExpressApplication, uploadsDir: string): void {
  app.useStaticAssets(uploadsDir, {
    prefix: UPLOADS_URL_PREFIX,
    setHeaders: (res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  });
}
