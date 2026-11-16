import 'reflect-metadata';

/**
 * `npm run e2e:seed`: aplica a semente fixa no banco de `FLYER_PRO_E2E_DB_URL` (D-1). Veja `runE2eSeedCommand`.
 *
 * Fora do Jest não existe `describe`, e `scene-test-db.ts` (que a lista de entidades e a limpeza das cenas reaproveitam)
 * o lê no topo do arquivo: um `describe` vazio basta, e o comando não roda spec nenhum.
 */
const globals = globalThis as { describe?: unknown };
globals.describe ??= Object.assign(() => undefined, { skip: () => undefined });

import('./e2e-seed-command')
  .then(({ runE2eSeedCommand }) => runE2eSeedCommand())
  .then((summary) => {
    console.log(`Semente do e2e aplicada no banco ${summary.database}.`);
    console.log(`Login: ${summary.email} / ${summary.password}`);
    console.log(`Clientes: ${summary.clients.join('; ')}`);
    console.log(`Cenas: ${summary.scenes.join('; ')}`);
    console.log(`Fotos: ${summary.images.join('; ')}`);
    console.log(`Arquivos em ${summary.uploadsDir}, URLs em ${summary.cdnUrl}`);
  })
  .catch((error: Error) => {
    console.error(`e2e:seed falhou: ${error.message}`);
    process.exit(1);
  });
