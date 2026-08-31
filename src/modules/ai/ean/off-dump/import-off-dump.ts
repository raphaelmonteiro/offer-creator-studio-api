/**
 * Feature 14 — Fase 2: ingestão do dump da Open Food Facts.
 *
 * Uso:
 *   node -r ts-node/register -r tsconfig-paths/register \
 *     src/modules/ai/ean/off-dump/import-off-dump.ts [opções]
 *
 *   --file=<caminho>     usa um .csv.gz local em vez de baixar
 *   --country=en:brazil  filtro de país (padrão: en:brazil)
 *   --limit=<n>          para após N linhas aceitas (teste)
 *   --all-countries      ignora o filtro de país
 *
 * O dump tem ~0,9 GB comprimido e ~9 GB descomprimido, com 211 colunas
 * separadas por TAB. Nada é gravado em disco: o gzip é descomprimido em
 * streaming e só as linhas do país escolhido chegam ao Postgres.
 *
 * Qualidade: a OFF é colaborativa e tem lixo (ex.: código `00000022` com
 * marca "Coca-Cola" e nome "Farandole de madeleine"). Toda linha passa pelo
 * checksum GS1 antes de entrar — é o filtro que remove esse tipo de entrada.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as readline from 'readline';
import { Readable } from 'stream';
import { Client } from 'pg';
import {
  isPlausibleRetailGtin,
  normalizeBrand,
  normalizeGtin,
  parseFreeTextQuantity,
} from '../gtin.util';

const DUMP_URL = 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz';

// Índices (0-based) das colunas usadas, confirmados no cabeçalho do dump.
const COL = {
  code: 0,
  productName: 10,
  quantity: 13,
  brands: 18,
  categories: 21,
  countriesTags: 40,
  servingSize: 50,
  imageUrl: 82,
  fat: 92,
  kcal: 89,
  carbs: 129,
  protein: 150,
} as const;

/**
 * Campo numérico da OFF: vazio, 'unknown' e lixo viram null.
 *
 * Cuidado: `Number('')` é 0, não NaN. Sem o teste de string vazia, 2.227
 * linhas sem valor nutricional viravam "0 kcal" — que é um número plausível
 * e portanto pior que um null, porque contamina qualquer comparação.
 */
function num(raw: string | undefined): number | null {
  const text = (raw ?? '').trim();
  if (!text || text.toLowerCase() === 'unknown') return null;
  const v = Number(text);
  return Number.isFinite(v) ? v : null;
}

const BATCH_SIZE = 1000;

interface Options {
  file: string | null;
  country: string | null;
  limit: number | null;
}

function parseArgs(argv: string[]): Options {
  const get = (name: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const limitRaw = get('limit');
  return {
    file: get('file'),
    country: argv.includes('--all-countries') ? null : (get('country') ?? 'en:brazil'),
    limit: limitRaw ? Number(limitRaw) : null,
  };
}

async function openSource(options: Options): Promise<NodeJS.ReadableStream> {
  if (options.file) {
    const resolved = path.resolve(options.file);
    console.log(`Lendo dump local: ${resolved}`);
    return fs.createReadStream(resolved);
  }

  console.log(`Baixando dump da OFF: ${DUMP_URL}`);
  // `static.openfoodfacts.org` responde 302 para o bucket S3.
  const response = await fetch(DUMP_URL, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Falha ao baixar o dump (HTTP ${response.status}).`);
  }
  return Readable.fromWeb(response.body as never);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USERNAME ?? 'stepup_user',
    password: process.env.DB_PASSWORD ?? 'secret123',
    database: process.env.DB_DATABASE ?? 'flyer_db',
  });
  await client.connect();

  const ddl = fs.readFileSync(path.join(__dirname, '..', 'sql', '001_off_products.sql'), 'utf8');
  await client.query(ddl);
  console.log('Tabela off_products pronta.');

  const source = await openSource(options);
  const rl = readline.createInterface({
    input: source.pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });

  let lineNo = 0;
  let matchedCountry = 0;
  let invalidGtin = 0;
  let inserted = 0;
  let batch: unknown[][] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    // INSERT multi-linha com placeholders posicionais; ON CONFLICT torna a
    // ingestão repetível (o dump é regerado todo dia).
    const cols = 14;
    const values: unknown[] = [];
    const tuples = batch.map((row, i) => {
      values.push(...row);
      const base = i * cols;
      return `(${Array.from({ length: cols }, (_, k) => `$${base + k + 1}`).join(',')})`;
    });

    await client.query(
      `INSERT INTO off_products
         (gtin, product_name, brand_raw, brand_norm, quantity_raw, quantity_value, quantity_unit, categories,
          image_url, serving_size, kcal_100g, carbs_100g, protein_100g, fat_100g)
       VALUES ${tuples.join(',')}
       ON CONFLICT (gtin) DO UPDATE SET
         product_name   = EXCLUDED.product_name,
         brand_raw      = EXCLUDED.brand_raw,
         brand_norm     = EXCLUDED.brand_norm,
         quantity_raw   = EXCLUDED.quantity_raw,
         quantity_value = EXCLUDED.quantity_value,
         quantity_unit  = EXCLUDED.quantity_unit,
         categories     = EXCLUDED.categories,
         image_url      = EXCLUDED.image_url,
         serving_size   = EXCLUDED.serving_size,
         kcal_100g      = EXCLUDED.kcal_100g,
         carbs_100g     = EXCLUDED.carbs_100g,
         protein_100g   = EXCLUDED.protein_100g,
         fat_100g       = EXCLUDED.fat_100g,
         ingested_at    = now()`,
      values,
    );
    inserted += batch.length;
    batch = [];
  };

  for await (const line of rl) {
    lineNo += 1;
    if (lineNo === 1) continue; // cabeçalho

    const cells = line.split('\t');
    if (cells.length < COL.countriesTags + 1) continue;

    if (options.country) {
      const countries = cells[COL.countriesTags] ?? '';
      if (!countries.includes(options.country)) continue;
    }
    matchedCountry += 1;

    const gtin = normalizeGtin(cells[COL.code]);
    if (!gtin || !isPlausibleRetailGtin(gtin)) {
      invalidGtin += 1;
      continue;
    }

    const brandRaw = (cells[COL.brands] ?? '').trim() || null;
    const quantityRaw = (cells[COL.quantity] ?? '').trim() || null;
    const quantity = parseFreeTextQuantity(quantityRaw);

    batch.push([
      gtin,
      (cells[COL.productName] ?? '').trim() || null,
      brandRaw,
      normalizeBrand(brandRaw),
      quantityRaw,
      quantity?.value ?? null,
      quantity?.unit ?? null,
      (cells[COL.categories] ?? '').trim() || null,
      (cells[COL.imageUrl] ?? '').trim() || null,
      (cells[COL.servingSize] ?? '').trim() || null,
      num(cells[COL.kcal]),
      num(cells[COL.carbs]),
      num(cells[COL.protein]),
      num(cells[COL.fat]),
    ]);

    if (batch.length >= BATCH_SIZE) await flush();

    if (lineNo % 500_000 === 0) {
      console.log(
        `  ${lineNo.toLocaleString()} linhas lidas | ${matchedCountry.toLocaleString()} do país | ${inserted.toLocaleString()} gravadas`,
      );
    }

    if (options.limit && inserted >= options.limit) break;
  }

  await flush();

  const [{ total }] = (
    await client.query<{ total: string }>('SELECT COUNT(*)::text AS total FROM off_products')
  ).rows;
  const [{ comQuantidade }] = (
    await client.query<{ comQuantidade: string }>(
      `SELECT COUNT(*)::text AS "comQuantidade" FROM off_products WHERE quantity_value IS NOT NULL AND brand_norm <> ''`,
    )
  ).rows;

  console.log('\n--- Ingestão concluída ---');
  console.log(`Linhas lidas no dump ......... ${lineNo.toLocaleString()}`);
  console.log(`Do país filtrado ............. ${matchedCountry.toLocaleString()}`);
  console.log(`Descartadas (GTIN inválido) .. ${invalidGtin.toLocaleString()}`);
  console.log(`Gravadas ..................... ${inserted.toLocaleString()}`);
  console.log(`Total na tabela .............. ${Number(total).toLocaleString()}`);
  console.log(`Consultáveis (marca+qtd) ..... ${Number(comQuantidade).toLocaleString()}`);

  await client.end();
}

main().catch((error) => {
  console.error('Falha na ingestão:', error);
  process.exit(1);
});
