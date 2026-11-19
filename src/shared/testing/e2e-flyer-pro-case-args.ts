import { FLYER_PRO_UNITS } from '../../modules/flyer-pro/domain/flyer-pro-categories';
import { FLYER_PRO_STEPS } from '../../modules/flyer-pro/domain/flyer-pro-steps';

type Unit = (typeof FLYER_PRO_UNITS)[number];
type Step = (typeof FLYER_PRO_STEPS)[number];

export interface CaseItem {
  name: string;
  unit: Unit;
  /** O preço simples em centavos (`{ kind: 'simple', cents }` na linha do item). */
  cents: number;
}

export interface CreateCaseInput {
  caseName: string;
  schemaVersion: number;
  engineVersion: number;
  step: Step;
  items: CaseItem[];
}

export type CaseCommand = { action: 'create'; input: CreateCaseInput } | { action: 'purge' };

/** O encarte de um caso se chama assim, com o texto do caso no fim (o nome da coluna cabe 120 caracteres). */
export const CASE_NAME_PREFIX = 'Ofertas Piccin semana 47 · ';
const NAME_LIMIT = 120;
const INTEGER_COLUMN_MAX = 2_147_483_647;

/** Os itens de um caso que não pede outros (A-8): o ABACATE a R$ 6,99 é o que os casos conferem. */
export const DEFAULT_CASE_ITEMS: CaseItem[] = [
  { name: 'ABACATE', unit: 'kg', cents: 699 },
  { name: 'CERVEJA PILSEN GARRAFA 600ML', unit: 'cada', cents: 449 },
  { name: 'ARROZ 5 kg', unit: 'pct', cents: 2490 },
];

const USAGE =
  'Uso: e2e:flyer-pro-case create --case <texto> --schema-version <n> --engine-version <n> [--step <etapa>] ' +
  "[--items '<JSON>'] | e2e:flyer-pro-case purge";

const CREATE_FLAGS = ['case', 'schema-version', 'engine-version', 'step', 'items'] as const;

/** `--nome valor` em pares; flag desconhecida, repetida ou sem valor é erro (nada é ignorado em silêncio). */
function readFlags(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const name = flag.startsWith('--') ? flag.slice(2) : '';
    if (!(CREATE_FLAGS as readonly string[]).includes(name)) {
      throw new Error(`Argumento desconhecido: ${flag}. ${USAGE}`);
    }
    if (value === undefined) throw new Error(`A flag ${flag} precisa de um valor. ${USAGE}`);
    if (flags.has(name)) throw new Error(`A flag ${flag} veio duas vezes.`);
    flags.set(name, value);
  }
  return flags;
}

/** `schemaVersion` e `engineVersion`: obrigatórios, sem padrão (A-18); o nome do campo vai na mensagem. */
function readVersion(flags: Map<string, string>, field: 'schemaVersion' | 'engineVersion'): number {
  const flag = field === 'schemaVersion' ? 'schema-version' : 'engine-version';
  const raw = flags.get(flag);
  if (raw === undefined) {
    throw new Error(`${field} ausente: passe --${flag} <inteiro a partir de 1>.`);
  }
  const value = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || value > INTEGER_COLUMN_MAX) {
    throw new Error(`${field} inválido (${raw}): use um inteiro a partir de 1.`);
  }
  return value;
}

function readCaseName(flags: Map<string, string>): string {
  const caseName = flags.get('case')?.trim();
  if (!caseName) throw new Error('case ausente: passe --case <texto curto do caso>.');
  if (CASE_NAME_PREFIX.length + caseName.length > NAME_LIMIT) {
    throw new Error(`case grande demais: o nome do encarte passaria de ${NAME_LIMIT} caracteres.`);
  }
  return caseName;
}

function readStep(flags: Map<string, string>): Step {
  const step = flags.get('step') ?? 'products';
  if (!(FLYER_PRO_STEPS as readonly string[]).includes(step)) {
    throw new Error(`step inválido (${step}): use uma de ${FLYER_PRO_STEPS.join(', ')}.`);
  }
  return step as Step;
}

function readItemName(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > NAME_LIMIT) {
    throw new Error(`${where}.name deve ser um texto de 1 a ${NAME_LIMIT} caracteres.`);
  }
  return value;
}

function readItemUnit(value: unknown, where: string): Unit {
  if (!(FLYER_PRO_UNITS as readonly unknown[]).includes(value)) {
    throw new Error(`${where}.unit inválida: use uma de ${FLYER_PRO_UNITS.join(', ')}.`);
  }
  return value as Unit;
}

function readItemCents(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${where}.cents deve ser um inteiro de centavos, 0 ou mais.`);
  }
  return value;
}

function readItem(raw: unknown, index: number): CaseItem {
  const where = `items[${index}]`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where} deve ser um objeto { name, unit, cents }.`);
  }
  const { name, unit, cents } = raw as Record<string, unknown>;
  return {
    name: readItemName(name, where),
    unit: readItemUnit(unit, where),
    cents: readItemCents(cents, where),
  };
}

function readItems(flags: Map<string, string>): CaseItem[] {
  const raw = flags.get('items');
  if (raw === undefined) return DEFAULT_CASE_ITEMS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('items deve ser um JSON: [{ "name": "ABACATE", "unit": "kg", "cents": 699 }].');
  }
  if (!Array.isArray(parsed)) throw new Error('items deve ser uma lista de itens.');
  return parsed.map(readItem);
}

/** Lê a linha de comando (`create ...` ou `purge`); qualquer defeito vira erro em pt-BR antes de abrir o banco. */
export function parseCaseArgs(argv: string[]): CaseCommand {
  const [action, ...rest] = argv;
  if (action === 'purge') {
    if (rest.length > 0) throw new Error(`purge não recebe argumentos. ${USAGE}`);
    return { action };
  }
  if (action !== 'create') throw new Error(`Ação desconhecida (${action ?? 'nenhuma'}). ${USAGE}`);
  const flags = readFlags(rest);
  return {
    action,
    input: {
      caseName: readCaseName(flags),
      schemaVersion: readVersion(flags, 'schemaVersion'),
      engineVersion: readVersion(flags, 'engineVersion'),
      step: readStep(flags),
      items: readItems(flags),
    },
  };
}
