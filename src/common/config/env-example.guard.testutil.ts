import { listSourceFiles, SourceFile, stripComments } from './source-files.testutil';

/**
 * Regras do teste de guarda do `.env.example` (capability backend-env-profile): quais variáveis o código lê e
 * quais linhas o exemplo traz. Funções puras sobre texto, para o guarda (e os cenários dele) rodarem sem o disco.
 */

/** Prefixos das variáveis de IA e de função cobertas pelo exemplo (requisito "Toda variável de IA e de função no exemplo"). */
export const COVERED_PREFIX =
  /^(AI_|OPENAI_|TEMPLATE_SCENE_|FLYER_PRO_|MC_|EAN_|DOTCOMPANY_|GEMINI_|ELEVENLABS_|ANIMATIONS_|IMAGE_TO_VIDEO_|GC_)/;

/** Chaves de provedor e token de administração: também cobertos, qualquer que seja o prefixo. */
export const SECRET_NAMES = [
  'OPENAI_API_KEY',
  'PIXABAY_API_KEY',
  'REPLICATE_API_TOKEN',
  'DOTCOMPANY_API_TOKEN',
  'FAL_API_KEY',
  'ELEVENLABS_API_KEY',
  'GEMINI_API_KEY',
  'RUNWAY_API_KEY',
  'HEYGEN_API_KEY',
  'ADMIN_API_TOKEN',
] as const;

/**
 * Segredos do servidor que o exemplo também não pode trazer com valor, mesmo fora do escopo de IA (R3): sem eles a API não
 * sobe (JWT) ou não conecta (banco, SMTP), então um valor de exemplo só serviria para subir a produção com ele.
 */
export const SERVER_SECRET_NAMES = [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'DB_PASSWORD',
  'SMTP_PASS',
] as const;

/** Nomes que o exemplo traz sempre em branco: as chaves de provedor, o token de administração e os segredos do servidor. */
const BLANK_NAMES: readonly string[] = [...SECRET_NAMES, ...SERVER_SECRET_NAMES];

/**
 * Lidas só pelos testes (banco de integração, harness de e2e, binário de teste): ficam fora do exemplo de produção.
 * Cada uma cita o arquivo que a lê.
 */
export const TEST_ONLY_VARS: Record<string, string> = {
  EAN_IT_DB_HOST: 'modules/ai/ean/ean-test-db.ts',
  EAN_IT_DB_NAME: 'modules/ai/ean/ean-test-db.ts',
  EAN_IT_DB_PORT: 'modules/ai/ean/ean-test-db.ts',
  FLYER_PRO_E2E_DB_URL: 'shared/testing/e2e-test-db.ts',
  TEMPLATE_SCENE_E2E_DB_URL: 'modules/template-scenes/testing/scene-test-db.ts',
  MC_TEST_FFMPEG: 'modules/commercials/domain/__fixtures__/mc-ffmpeg-fixture.helpers.ts',
};

/**
 * Literais em maiúsculas com o prefixo coberto que NÃO são variável de ambiente: código de erro, token de injeção
 * e rótulo de log. Cada um cita onde aparece.
 */
export const NOT_ENV_LITERALS: Record<string, string> = {
  AI_DISABLED: 'flyer-pro/domain/flyer-pro-enrich-rules.ts (motivo de fase pulada)',
  EAN_FORMAT: 'flyer-pro/domain/flyer-pro-item-rules.ts (código de validação)',
  FLYER_PRO_ENRICH_CONFIG: 'flyer-pro/config/flyer-pro-enrich.config.ts (token de injeção)',
  FLYER_PRO_STRUCTURE_AI_CONFIG: 'flyer-pro/config/structure-ai.config.ts (token de injeção)',
  MC_TALK_ENGINE: 'commercials/domain/mc-pipeline.config.ts (rótulo da mensagem de erro)',
};

/**
 * Lidas só para avisar que não têm efeito (modules/ai/openai-retiring-models.service.ts): nenhuma linha delas no exemplo é
 * leitura de verdade, então não exigem linha e uma linha delas é linha sem leitor.
 */
export const NO_EFFECT_VARS = [
  'OPENAI_ENABLE_DALLE_FALLBACK',
  'OPENAI_DALLE_FALLBACK_MODEL',
] as const;

/** Nomes dinâmicos (montados em tempo de execução): uma linha com o prefixo cobre qualquer nome lido com ele. */
export const DYNAMIC_PREFIXES = ['OPENAI_COST_', 'MC_TALK_ENGINE_'] as const;

const SOURCE_SKIP_DIRS = new Set(['node_modules', 'migrations']);
const TEST_FILE = /\.(spec|test|testutil|fixture)\.ts$/;

/** Os `.ts` de produção (e os ajudantes de harness) sob `dir`, sem testes, fixtures e migrations. */
export function listSources(dir: string): SourceFile[] {
  return listSourceFiles(dir, {
    skipDirs: SOURCE_SKIP_DIRS,
    skipFile: (name) => TEST_FILE.test(name),
  });
}

const CAPS_LITERAL = /(['"`])([A-Z][A-Z0-9_]{2,})\1/g;
const ENV_DOT = /\benv\.([A-Z][A-Z0-9_]+)/g;
const PREFIX_DECL = /\bPREFIX\s*=\s*'([A-Z0-9_]+_)'/;

/** O literal é um código de erro ou um token (não uma leitura): `code: 'X'`, união de tipos, `Symbol('X')`, `const X = 'X'`. */
function isNotARead(code: string, index: number, name: string): boolean {
  const lineStart = code.lastIndexOf('\n', index) + 1;
  const before = code.slice(lineStart, index);
  if (/code:\s*$|^\s*\|\s*$|Extract<[^>]*$|Symbol\(\s*$/.test(before)) return true;
  return new RegExp(`const ${name}\\s*=\\s*$`).test(before);
}

/** Nomes que um arquivo lê: `process.env.X` ou `env.X`, literais em maiúsculas e, no arquivo com `PREFIX = 'P_'`, `P_` + cada sufixo. */
export function envNamesRead(file: SourceFile): string[] {
  if (/\.errors\.ts$/.test(file.rel)) return [];
  const code = stripComments(file.text);
  const names = new Set<string>();
  for (const m of code.matchAll(ENV_DOT)) names.add(m[1]);
  const prefix = PREFIX_DECL.exec(code)?.[1];
  for (const m of code.matchAll(CAPS_LITERAL)) {
    const name = m[2];
    if (name.endsWith('_') || isNotARead(code, m.index ?? 0, name)) continue;
    names.add(prefix && !name.startsWith(prefix) ? prefix + name : name);
  }
  return [...names];
}

/** O nome está no escopo do exemplo: prefixo de IA ou de função, chave de provedor ou token de administração. */
export function isCovered(name: string): boolean {
  return COVERED_PREFIX.test(name) || (SECRET_NAMES as readonly string[]).includes(name);
}

/** Variáveis de IA e de função (e as chaves) lidas pelo código, com o arquivo que cada uma cita, sem testes e sem os literais que não são variável. */
export function coveredReads(files: SourceFile[]): Map<string, string> {
  const reads = new Map<string, string>();
  for (const file of files) {
    for (const name of envNamesRead(file)) {
      const skipped =
        name in NOT_ENV_LITERALS || (NO_EFFECT_VARS as readonly string[]).includes(name);
      if (isCovered(name) && !skipped && !reads.has(name)) reads.set(name, file.rel);
    }
  }
  return reads;
}

/** Todo nome em maiúsculas que algum arquivo lê com efeito (para a linha sem leitor, qualquer prefixo). */
export function anyNameRead(files: SourceFile[]): Set<string> {
  const names = new Set(files.flatMap((file) => envNamesRead(file)));
  NO_EFFECT_VARS.forEach((name) => names.delete(name));
  return names;
}

export interface ExampleLine {
  name: string;
  value: string;
  /** Linha comentada com o valor (`# NOME=valor`), que vale como linha do exemplo. */
  commented: boolean;
  line: number;
}

const ASSIGNMENT = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/;

/** As linhas `NOME=valor` do exemplo, ativas ou comentadas; o comentário no fim da linha sai do valor. */
export function parseExample(text: string): ExampleLine[] {
  return text.split('\n').flatMap((raw, index) => {
    const m = ASSIGNMENT.exec(raw.trim());
    if (!m) return [];
    const value = m[3].replace(/\s+#.*$/, '').trim();
    return [{ name: m[2], value, commented: Boolean(m[1]), line: index + 1 }];
  });
}

export function coveredByDynamicPrefix(name: string): boolean {
  return DYNAMIC_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export interface ProfileProblems {
  /** Variável lida pelo código sem linha no exemplo, com o arquivo que a lê. */
  unlisted: string[];
  /** Linha de variável de IA ou de função sem leitor, com o número da linha. */
  unread: string[];
  /** Chave, token ou senha (de provedor ou do servidor) com valor, com o número da linha. */
  secretsWithValue: string[];
}

/** Compara o que o código lê com o que o exemplo traz (os três requisitos de "Toda variável…" e "Segredos em branco"). */
export function profileProblems(files: SourceFile[], exampleText: string): ProfileProblems {
  const lines = parseExample(exampleText);
  const listed = new Set(lines.map((line) => line.name));
  const read = anyNameRead(files);
  const unlisted = [...coveredReads(files)]
    .filter(([name]) => !listed.has(name) && !(name in TEST_ONLY_VARS))
    .filter(
      ([name]) => !(coveredByDynamicPrefix(name) && lines.some((l) => sharesPrefix(l.name, name))),
    )
    .map(([name, file]) => `${name} (lida em ${file})`);
  const unread = lines
    .filter(
      (line) => isCovered(line.name) && !read.has(line.name) && !coveredByDynamicPrefix(line.name),
    )
    .map((line) => `${line.name} (linha ${line.line})`);
  const secretsWithValue = lines
    .filter((line) => BLANK_NAMES.includes(line.name) && line.value !== '')
    .map((line) => `${line.name} (linha ${line.line})`);
  return { unlisted, unread, secretsWithValue };
}

function sharesPrefix(a: string, b: string): boolean {
  const prefix = DYNAMIC_PREFIXES.find((p) => b.startsWith(p));
  return prefix !== undefined && a.startsWith(prefix);
}
