/**
 * Vocabulário central do módulo de comerciais (plano-comerciais §6.1).
 * Tipos puros compartilhados por entidades, scheduler, pricing e processors —
 * sem dependência de Nest/TypeORM para manter o domain 100% testável.
 */

/** Tipos de step — a unidade de execução/custo/cache (plano §6.1 mc_steps). */
export enum McStepType {
  SCRIPT = 'script',
  KEYFRAME = 'keyframe',
  VIDEO = 'video',
  TTS = 'tts',
  LIPSYNC = 'lipsync',
  ASSEMBLY = 'assembly',
}

export const MC_ASPECT_RATIOS = ['9:16', '1:1', '16:9'] as const;
export type McAspectRatio = (typeof MC_ASPECT_RATIOS)[number];

/**
 * Roteiro (mc_projects.script, jsonb) — fonte de verdade do comercial
 * (plano §6.1). `dialogue: null` = cena muda (sem tts/lipsync).
 *
 * McScript v2 (v1-B1, multi-cena): `actionPromptEn` carrega a MESMA ação em
 * inglês, porque os motores de vídeo/keyframe respondem muito melhor em EN
 * (lição do PoC) enquanto a UI mostra `actionPrompt` em pt. Roteiros v1 (1
 * cena, sem `actionPromptEn`) continuam válidos — o campo é opcional e quem
 * consome cai no `actionPrompt` (ver `sceneActionPromptEn`).
 */
export interface McScriptScene {
  idx: number;
  /** Ação da cena em pt-BR — é o que a UI mostra e o usuário edita. */
  actionPrompt: string;
  /** Mesma ação em inglês — input dos motores de vídeo/keyframe (v2). */
  actionPromptEn?: string;
  dialogue: string | null;
  durationS: number;
}

/** Produto do selo determinístico (plano §5.4): nome + preço prontos, vindos do catálogo. */
export interface McSealProduct {
  name: string;
  price: string;
}

/**
 * Selo determinístico aplicado pelo ffmpeg na montagem (plano §5.4: preço/
 * nome/validade NUNCA passam pelo modelo de vídeo).
 * - v2 (v1-B1): `products` — até 6 produtos, 1 selo por cena (rotativo).
 * - v0/v1 (compat): `text` — um texto único no terço inferior.
 * Os dois convivem: a montagem prefere `products` e cai em `text`.
 */
export interface McScriptSeal {
  products?: McSealProduct[];
  text?: string;
}

/** Cartela final determinística (2s) com o nome do estabelecimento (plano §5.4). */
export interface McScriptEndcard {
  storeName: string;
}

export interface McScript {
  version: number;
  scenes: McScriptScene[];
  /** Selo opcional da montagem (plano §5.4); ausente = vídeo sem selo. */
  seal?: McScriptSeal | null;
  /** Cartela final opcional — ausente quando o usuário não tem estabelecimento. */
  endcard?: McScriptEndcard | null;
}

/**
 * Opções do projeto (mc_projects.options, jsonb) — decidido como UMA coluna
 * jsonb em vez de 3 colunas novas porque o conjunto é do domínio "preferências
 * de montagem" e tende a crescer (v1.x: SFX, marca d'água), enquanto
 * aspectRatio/targetDurationS continuam colunas próprias por serem chave de
 * hash/roteamento. Projetos antigos têm `options` NULL → defaults abaixo.
 */
export interface McProjectOptions {
  /** Trilha instrumental na montagem (plano §5.1 etapa 6). */
  musicEnabled: boolean;
  /** Legendas queimadas a partir dos timestamps do TTS (plano §5.4). */
  captionsEnabled: boolean;
  /** Produtos do catálogo que viram selos determinísticos (máx. 6). */
  products: McSealProduct[];
}

export const MC_DEFAULT_PROJECT_OPTIONS: McProjectOptions = {
  musicEnabled: true,
  captionsEnabled: true,
  products: [],
};

/** Máximo de produtos com selo em um comercial (plano §5.4 / contrato v1). */
export const MC_MAX_SEAL_PRODUCTS = 6;

/** Options com defaults aplicados — projetos anteriores ao v1-B1 têm a coluna NULL. */
export function resolveProjectOptions(options: Partial<McProjectOptions> | null): McProjectOptions {
  return {
    musicEnabled: options?.musicEnabled ?? MC_DEFAULT_PROJECT_OPTIONS.musicEnabled,
    captionsEnabled: options?.captionsEnabled ?? MC_DEFAULT_PROJECT_OPTIONS.captionsEnabled,
    products: (options?.products ?? []).slice(0, MC_MAX_SEAL_PRODUCTS),
  };
}

/**
 * Prompt de ação em INGLÊS de uma cena: usa o campo v2 quando existe e cai no
 * pt do roteiro v1 (motor recebe pt — degradação aceita e documentada, é o que
 * a v0 já fazia).
 */
export function sceneActionPromptEn(
  scene: Partial<Pick<McScriptScene, 'actionPrompt' | 'actionPromptEn'>>,
): string {
  const en = scene.actionPromptEn?.trim();
  if (en && en.length > 0) return en;
  return scene.actionPrompt?.trim() ?? '';
}

/** Produtos do selo, normalizados (compat com o selo de texto único da v0). */
export function sealProducts(seal: McScriptSeal | null | undefined): McSealProduct[] {
  if (!seal) return [];
  if (Array.isArray(seal.products) && seal.products.length > 0) {
    return seal.products.slice(0, MC_MAX_SEAL_PRODUCTS);
  }
  return [];
}
