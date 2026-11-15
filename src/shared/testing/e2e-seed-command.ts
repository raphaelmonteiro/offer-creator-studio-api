import { resolveUploadsDir } from '../../common/config/uploads-dir';
import { applyE2eSeed } from './e2e-seed';
import { FIXED_IDENTITY } from './e2e-seed-identity';
import { assertE2eDbUrl, e2eDbNameOf, E2E_DB_ENV, openE2eDb } from './e2e-test-db';

export interface SeedCommandSummary {
  database: string;
  email: string;
  password: string;
  clients: string[];
  scenes: string[];
  images: string[];
  uploadsDir: string;
  cdnUrl: string;
}

/**
 * O comando da semente para o e2e de navegador (D-1). Confere o banco com a mesma recusa do harness (antes de conectar),
 * monta o banco como o Jest e aplica a semente com identificadores fixos: o login `e2e@chroma.local`, 2 clientes, 2 cenas
 * e 2 fotos. Idempotente. Grava a arte e as fotos em `UPLOAD_DEST` e monta as URLs com `CDN_URL`, as pastas e o
 * endereço da segunda API do e2e de navegador.
 */
export async function runE2eSeedCommand(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeedCommandSummary> {
  const url = env[E2E_DB_ENV];
  assertE2eDbUrl(url);
  const { UPLOAD_DEST: uploads, CDN_URL: cdnUrl } = env;
  if (!uploads || !cdnUrl) {
    throw new Error(
      'Defina UPLOAD_DEST (a pasta de uploads da API do e2e de navegador) e CDN_URL (o endereço público ' +
        'dessa pasta, como http://localhost:3102/uploads).',
    );
  }
  const uploadsDir = resolveUploadsDir(uploads);
  const dataSource = await openE2eDb(url);
  try {
    const seed = await applyE2eSeed(dataSource, { uploadsDir, cdnUrl, identity: FIXED_IDENTITY });
    return {
      database: e2eDbNameOf(url as string),
      email: seed.identity.email,
      password: seed.identity.password,
      clients: [seed.clientWithLibrary.name, seed.clientLegacyFooter.name],
      scenes: [seed.scenes.frontBack.name, seed.scenes.tabloid.name],
      images: seed.images.map((image) => image.url),
      uploadsDir,
      cdnUrl,
    };
  } finally {
    await dataSource.destroy();
  }
}
