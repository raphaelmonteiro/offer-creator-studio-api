import { McKitSource, McKitStyle, styleBlockLine } from './mc-kit-identity';

/**
 * Prompts FIXOS das 4 imagens de referência do kit do personagem
 * (plano-comerciais §4: turnaround + expressões + pose com prop). Função pura,
 * sem Nest/IO — os prompts são parte do contrato de reprodutibilidade do kit
 * (mudá-los muda o resultado; versionar aqui, testar no spec).
 *
 * A imagem do mascote SEMPRE vai junto como referência (inlineData) — o texto
 * ancora pose/enquadramento e a fidelidade visual vem da referência + da
 * descrição canônica (quando já existir).
 *
 * Change video-formatos-personagem (D1/D5): o estilo entra como bloco FIXO
 * (`STYLE_BLOCKS`) em todo slot — `adjustments` volta a ser só ajuste do
 * usuário, nunca alavanca de estilo; com `source = 'logo'` as marcas do logo
 * fazem parte da identidade (cai o "no logo", fica a proibição de texto
 * adicionado); a cor de fundo do slot frontal é parâmetro.
 */

/**
 * Item da ficha em duas línguas: `en` é o que vai para os motores de imagem
 * (o contrato de prompt do plano é em inglês), `pt` é o que o usuário lê e
 * edita na revisão do kit. Kits antigos só têm o inglês — `pt` cai no `en`.
 */
export interface KitSheetItem {
  en: string;
  pt?: string;
}

/** Descrição canônica do personagem (JSON persistido em mc_character_kits.canonicalDesc). */
export interface KitCanonicalDesc {
  /** Traços INERENTES: corpo, pelagem, roupa, proporções — o que é o personagem. */
  traits: string[];
  /** Cores dominantes (nomes ou hex) — insumo do QA de cor do plano §4. */
  colors: string[];
  /** Estilo visual (ex.: 'cartoon 3D', 'flat 2D'). */
  style: string;
  /** O que NUNCA mudar/fazer com o personagem. */
  doNots: string[];
  /**
   * Props REMOVÍVEIS que aparecem na arte original (cesta, caixa, celular,
   * bandeja). Não são o personagem: ficam fora das referências e só entram
   * numa cena quando a ação pede. Separá-los de `traits` é o que impede o
   * mascote de arrastar a cesta de frutas por todas as cenas do comercial.
   */
  accessories?: string[];
  /** Instruções livres do usuário, em inglês, aplicadas a toda geração. */
  adjustments?: string;
  /** Espelho pt-BR para exibição/edição na UI (mesma ordem dos arrays em inglês). */
  pt?: KitCanonicalDescPt;
}

/** Espelho em pt-BR da ficha — só exibição; os motores leem sempre o inglês. */
export interface KitCanonicalDescPt {
  traits?: string[];
  style?: string;
  doNots?: string[];
  accessories?: string[];
  adjustments?: string;
}

/** Slots fixos do grid de referências (0..3). A ordem é contrato da UI de review. */
export const KIT_REFERENCE_SLOTS = [
  'three_quarter_left',
  'profile',
  'talking',
  'holding_product',
] as const;

export type KitReferenceSlot = 0 | 1 | 2 | 3;

export const KIT_REFERENCE_SLOT_COUNT = KIT_REFERENCE_SLOTS.length;

/**
 * Único slot em que o personagem segura algo — e é uma caixa genérica, não o
 * acessório da arte original. Nos demais as mãos ficam livres.
 */
export const KIT_SLOT_WITH_PROP: KitReferenceSlot = 3;

/**
 * Slot FRONTAL (identidade): a única referência de frente do grid e a que o
 * tile recorta (D1 "referência frontal canônica"). Só ele recebe a cor de
 * fundo parametrizada; os demais seguem no cinza claro de sempre.
 */
export const KIT_FRONT_SLOT: KitReferenceSlot = 2;

/** Cor de fundo padrão do slot frontal — o mesmo "light gray" fixo de antes. */
export const KIT_REFERENCE_BACKGROUND_DEFAULT = 'light gray';

/** Opções de identidade do kit que entram no prompt (todas opcionais = comportamento legado). */
export interface KitReferencePromptOptions {
  style?: McKitStyle | null;
  source?: McKitSource | null;
  /** Cor de fundo do slot frontal: nome em inglês ("light gray") ou hex (#RRGGBB[AA]). */
  backgroundColor?: string | null;
}

/** Pose de cada slot (a cauda — fundo, luz, proibições — é montada por `slotTail`). */
const SLOT_POSES: readonly string[] = [
  // 0 — ¾ esquerda
  'Turnaround reference: the exact same mascot character from the reference image, ' +
    'three-quarter view facing left, full body, neutral standing pose, arms relaxed.',
  // 1 — perfil
  'Turnaround reference: the exact same mascot character from the reference image, ' +
    'full profile (side) view, full body, neutral standing pose.',
  // 2 — pose de fala (frente)
  'Expression reference: the exact same mascot character from the reference image, ' +
    'front view, talking pose with mouth open mid-speech and hands gesturing expressively, ' +
    'friendly and energetic.',
  // 3 — segurando produto genérico
  'Action reference: the exact same mascot character from the reference image, ' +
    'front three-quarter view, cheerfully holding a plain generic unlabeled product box ' +
    'with both hands at chest height, presenting it to the camera.',
];

/** "light gray" vira o texto de sempre; hex vira cor exata (o tile precisa de borda uniforme). */
function backgroundDirective(color: string): string {
  const value = color.trim() || KIT_REFERENCE_BACKGROUND_DEFAULT;
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
    return `Plain solid background filled with the exact color ${value.toUpperCase()} (uniform, no gradient, no texture)`;
  }
  return `Plain solid ${value} background`;
}

/**
 * Cauda do slot: fundo, luz e proibições. Com origem `logo` as marcas e
 * letras do próprio logo SÃO a identidade — cai o "no logo", fica proibido só
 * texto adicionado/promocional.
 */
function slotTail(slot: KitReferenceSlot, options: KitReferencePromptOptions): string {
  const background = backgroundDirective(
    slot === KIT_FRONT_SLOT
      ? (options.backgroundColor ?? KIT_REFERENCE_BACKGROUND_DEFAULT)
      : KIT_REFERENCE_BACKGROUND_DEFAULT,
  );
  const ban =
    options.source === 'logo'
      ? 'no added text, no watermark (the lettering and marks that belong to the logo itself ' +
        'stay exactly as in the reference)'
      : 'no text, no logo, no watermark';
  return `${background}, even studio lighting, ${ban}.`;
}

/**
 * Linha dos ajustes do usuário. Com estilo fixo no kit eles deixam de ser
 * "highest priority": refinam o personagem, nunca o estilo (D5 — fim do hack
 * de escrever o estilo em `adjustments`). Compartilhada com o keyframe.
 */
export function userAdjustmentsLine(adjustments: string, styleFixed: boolean): string {
  return styleFixed
    ? '- User adjustments (follow strictly; they refine the character but never override ' +
        `the fixed rendering style above): ${adjustments}`
    : `- User adjustments (highest priority, follow strictly): ${adjustments}`;
}

/** Guarda de slot compartilhada por prompt-builder, DTO e processor. */
export function isKitReferenceSlot(value: unknown): value is KitReferenceSlot {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

/** Strings não-vazias de um array desconhecido (defesa contra JSON de fora). */
function cleanList(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 240))
    .slice(0, max);
}

/**
 * Parser único do JSON persistido (antes duplicado em dois processors e no
 * frontend). Tolera kits antigos (sem `accessories`/`pt`) e lixo parcial:
 * o que não der para ler vira lista vazia em vez de derrubar a geração.
 */
export function parseCanonicalDesc(raw: string | null | undefined): KitCanonicalDesc | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.traits)) return null;
  const ptRaw = (record.pt ?? {}) as Record<string, unknown>;
  const desc: KitCanonicalDesc = {
    traits: cleanList(record.traits),
    colors: cleanList(record.colors, 12),
    style: typeof record.style === 'string' ? record.style.trim().slice(0, 240) : '',
    doNots: cleanList(record.doNots),
    accessories: cleanList(record.accessories, 12),
    ...(typeof record.adjustments === 'string' && record.adjustments.trim()
      ? { adjustments: record.adjustments.trim().slice(0, 600) }
      : {}),
  };
  // O espelho só vale item a item: comprimento diferente = pareamento quebrado,
  // e aí é melhor exibir o inglês do que legenda trocada. Lista vazia não vira
  // espelho (senão ficha v1, sem `pt`, ganharia um pt fantasma de arrays vazios).
  const mirror = (value: unknown, expected: number, max = 20): string[] | null => {
    const list = cleanList(value, max);
    return list.length > 0 && list.length === expected ? list : null;
  };
  const ptTraits = mirror(ptRaw.traits, desc.traits.length);
  const ptDoNots = mirror(ptRaw.doNots, desc.doNots.length);
  const ptAccessories = mirror(ptRaw.accessories, desc.accessories?.length ?? 0, 12);
  const pt: KitCanonicalDescPt = {
    ...(ptTraits ? { traits: ptTraits } : {}),
    ...(ptDoNots ? { doNots: ptDoNots } : {}),
    ...(ptAccessories ? { accessories: ptAccessories } : {}),
    ...(typeof ptRaw.style === 'string' && ptRaw.style.trim()
      ? { style: ptRaw.style.trim().slice(0, 240) }
      : {}),
    ...(typeof ptRaw.adjustments === 'string' && ptRaw.adjustments.trim()
      ? { adjustments: ptRaw.adjustments.trim().slice(0, 600) }
      : {}),
  };
  if (Object.keys(pt).length > 0) desc.pt = pt;
  return desc;
}

/** Tradução devolvida pelo modelo para a ficha de um kit antigo (só inglês). */
export interface KitSheetTranslation {
  traits?: string[];
  accessories?: string[];
  doNots?: string[];
  style?: string;
}

/**
 * Aplica a tradução à ficha, item a item. Só aceita lista de MESMO tamanho —
 * tradução com item a mais/a menos desalinha o pareamento por índice da UI e
 * é descartada (fica em inglês, que é feio mas correto).
 */
export function mergeTranslatedSheet(
  desc: KitCanonicalDesc,
  translation: KitSheetTranslation,
): KitCanonicalDesc {
  const same = (list: unknown, expected: number): string[] | undefined => {
    const clean = cleanList(list);
    return clean.length > 0 && clean.length === expected ? clean : undefined;
  };
  const pt: KitCanonicalDescPt = {
    ...(desc.pt ?? {}),
    ...(same(translation.traits, desc.traits.length)
      ? { traits: same(translation.traits, desc.traits.length) }
      : {}),
    ...(same(translation.doNots, desc.doNots.length)
      ? { doNots: same(translation.doNots, desc.doNots.length) }
      : {}),
    ...(same(translation.accessories, desc.accessories?.length ?? 0)
      ? { accessories: same(translation.accessories, desc.accessories?.length ?? 0) }
      : {}),
    ...(typeof translation.style === 'string' && translation.style.trim()
      ? { style: translation.style.trim().slice(0, 240) }
      : {}),
  };
  return Object.keys(pt).length > 0 ? { ...desc, pt } : desc;
}

/** A ficha já tem espelho pt para tudo que está preenchido? (gate do botão de traduzir) */
export function hasPtMirror(desc: KitCanonicalDesc): boolean {
  const covered = (list: string[] | undefined, mirror: string[] | undefined): boolean =>
    (list?.length ?? 0) === 0 || (mirror?.length ?? 0) === (list?.length ?? 0);
  return (
    covered(desc.traits, desc.pt?.traits) &&
    covered(desc.doNots, desc.pt?.doNots) &&
    covered(desc.accessories, desc.pt?.accessories)
  );
}

/**
 * Regra de props das referências: a folha de personagem descreve QUEM ele é,
 * não o que ele carrega. Sem isso, a cesta de frutas da arte original vira
 * parte da identidade e reaparece em toda cena (relato de uso, v1.15).
 */
export function noPropsRule(accessories: string[] | undefined): string {
  const list = (accessories ?? []).filter((a) => a.trim());
  const named = list.length > 0 ? ` Specifically, do NOT include: ${list.join(', ')}.` : '';
  return (
    'IMPORTANT — the character must NOT hold or carry any object, prop or accessory: ' +
    `both hands are empty and clearly visible.${named}`
  );
}

/**
 * Prompt do slot: pose + cauda (fundo/luz/proibições) + bloco FIXO de estilo
 * (quando o kit tem estilo) + descrição canônica quando disponível (a
 * descrição reforça identidade: cores e do-nots entram como regras; o estilo
 * livre da ficha só entra quando NÃO há estilo fixo, para não disputar com
 * ele). Acessórios entram como NEGATIVA (exceto no slot da caixa genérica,
 * que já tem o próprio prop) e os ajustes do usuário vêm por último.
 */
export function buildKitReferencePrompt(
  slot: KitReferenceSlot,
  canonicalDesc?: KitCanonicalDesc | null,
  options: KitReferencePromptOptions = {},
): string {
  if (!isKitReferenceSlot(slot)) {
    throw new Error(`Slot de referência inválido: ${String(slot)} (esperado 0..3)`);
  }
  const styleLine = styleBlockLine(options.style);
  const lines: string[] = [`${SLOT_POSES[slot]} ${slotTail(slot, options)}`];
  if (styleLine) lines.push(styleLine);
  if (!canonicalDesc) return lines.join('\n');
  lines.push('', 'Character sheet (keep the character EXACTLY like this):');
  if (canonicalDesc.traits.length > 0) lines.push(`- Traits: ${canonicalDesc.traits.join('; ')}`);
  if (canonicalDesc.colors.length > 0) lines.push(`- Colors: ${canonicalDesc.colors.join(', ')}`);
  if (canonicalDesc.style && !styleLine) lines.push(`- Style: ${canonicalDesc.style}`);
  if (canonicalDesc.doNots.length > 0) {
    lines.push(`- Never: ${canonicalDesc.doNots.join('; ')}`);
  }
  if (slot !== KIT_SLOT_WITH_PROP) {
    lines.push(`- ${noPropsRule(canonicalDesc.accessories)}`);
  } else if ((canonicalDesc.accessories?.length ?? 0) > 0) {
    lines.push(
      `- The only object in the image is the plain generic box; do NOT add: ${canonicalDesc.accessories!.join(', ')}.`,
    );
  }
  if (canonicalDesc.adjustments) {
    lines.push(userAdjustmentsLine(canonicalDesc.adjustments, !!styleLine));
  }
  return lines.join('\n');
}

// ───────────────────── candidatos de mascotização e variante com boca (D4) ─────────────────────

/** Cor de fundo padrão do tile e dos candidatos de um kit de logo (cinza claro, uniforme). */
export const KIT_TILE_BACKGROUND_DEFAULT = '#E5E7EB';

/**
 * Candidatos por rodada: 4 a 6 (spec "Candidatos de mascotização do logo").
 * O valor efetivo vem de MC_KIT_CANDIDATE_COUNT, sempre clampado a esta faixa.
 */
export const KIT_CANDIDATES_MIN = 4;
export const KIT_CANDIDATES_MAX = 6;
export const KIT_CANDIDATES_DEFAULT = 4;

/**
 * Pistas de variação por posição na rodada: a mesma chamada repetida só
 * varia pela amostragem; a pista pede que cada candidato seja visivelmente
 * distinto sem sair da identidade do logo.
 */
export const KIT_CANDIDATE_VARIATIONS: readonly string[] = [
  'the most faithful interpretation of the logo silhouette and marks',
  'rounder, friendlier proportions with a big expressive face',
  'a more dynamic pose and expression, energetic and welcoming',
  'bolder stylization while keeping every mark of the logo recognizable',
  'slimmer, taller proportions with a confident stance',
  'cute compact proportions with a large head and short limbs',
];

export interface KitCandidatePromptOptions {
  style: McKitStyle;
  /** Cor de fundo liso (hex ou nome em inglês); default KIT_TILE_BACKGROUND_DEFAULT. */
  backgroundColor?: string | null;
  /** Ajustes livres do usuário (já em inglês) desta rodada. */
  adjustments?: string | null;
  /** Posição (0-based) e total da rodada — escolhe a pista de variação. */
  idx: number;
  total: number;
  /** Quantas referências de estilo vão junto depois do logo (0..3). */
  styleReferenceCount?: number;
}

/**
 * Prompt do candidato de mascotização (Nano Banana `edit` com o logo como
 * primeira referência): personagem derivado do logo, mantendo formas, cores e
 * marcas, no estilo FIXO do kit, sobre fundo liso da cor do tile. Nunca
 * nomeia estúdios ou obras; proíbe texto adicionado (as letras do próprio
 * logo podem integrar o personagem).
 */
export function buildKitCandidatePrompt(options: KitCandidatePromptOptions): string {
  const refs = options.styleReferenceCount ?? 0;
  const lines = [
    'Create a brand mascot character derived from the logo in the first reference image. ' +
      'Keep the logo’s shapes, colors, and distinctive marks clearly recognizable in the ' +
      'character; turn the logo into a living, friendly character with a face, eyes and a ' +
      'clearly drawn mouth that can open and close for lip-sync animation.',
    'Front view, bust or full body, centered, facing the camera, neutral friendly pose, even ' +
      'studio lighting.',
    `${backgroundDirective(options.backgroundColor ?? KIT_TILE_BACKGROUND_DEFAULT)}, filling the ` +
      'whole frame edge to edge, with nothing else in the scene.',
    'No added text, no captions, no watermark (lettering that belongs to the logo itself may ' +
      'remain as part of the character).',
    styleBlockLine(options.style) as string,
  ];
  if (refs > 0) {
    lines.push(
      `The ${refs === 1 ? 'second image is a style reference' : `next ${refs} images are style references`} ` +
        'only: match their rendering finish, never copy their characters.',
    );
  }
  const total = Math.max(1, options.total);
  const hint = KIT_CANDIDATE_VARIATIONS[options.idx % KIT_CANDIDATE_VARIATIONS.length];
  lines.push(`Variation ${options.idx + 1} of ${total}: ${hint}.`);
  if (options.adjustments?.trim()) {
    lines.push(userAdjustmentsLine(options.adjustments.trim(), true));
  }
  return lines.join('\n');
}

export interface KitMouthVariantPromptOptions {
  style: McKitStyle | null;
  source: McKitSource;
  backgroundColor?: string | null;
}

/**
 * Variante com boca (gate de boca reprovado): a MESMA identidade, mudando só a
 * boca para uma boca desenhada com abertura, articulável — tudo o mais
 * (cores, formas, proporções, acessórios, fundo) permanece idêntico.
 */
export function buildMouthVariantPrompt(options: KitMouthVariantPromptOptions): string {
  const ban =
    options.source === 'logo'
      ? 'no added text, no watermark (lettering that belongs to the logo itself stays as is)'
      : 'no text, no logo, no watermark';
  const lines = [
    'Edit the character in the reference image so it has a clearly drawn, articulable mouth: ' +
      'visible lips or a mouth opening, slightly open in a neutral friendly expression, suitable ' +
      'for lip-sync animation.',
    'Change NOTHING else: keep the exact same character, design, colors, proportions, outfit, ' +
      'accessories, pose, framing and lighting as in the reference image.',
    `${backgroundDirective(options.backgroundColor ?? KIT_REFERENCE_BACKGROUND_DEFAULT)}, ${ban}.`,
  ];
  const styleLine = styleBlockLine(options.style);
  if (styleLine) lines.push(styleLine);
  return lines.join('\n');
}
