/**
 * Prompts FIXOS das 4 imagens de referência do kit do personagem
 * (plano-comerciais §4: turnaround + expressões + pose com prop). Função pura,
 * sem Nest/IO — os prompts são parte do contrato de reprodutibilidade do kit
 * (mudá-los muda o resultado; versionar aqui, testar no spec).
 *
 * A imagem do mascote SEMPRE vai junto como referência (inlineData) — o texto
 * ancora pose/enquadramento e a fidelidade visual vem da referência + da
 * descrição canônica (quando já existir).
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

const SLOT_PROMPTS: readonly string[] = [
  // 0 — ¾ esquerda
  'Turnaround reference: the exact same mascot character from the reference image, ' +
    'three-quarter view facing left, full body, neutral standing pose, arms relaxed. ' +
    'Plain solid light gray background, even studio lighting, no text, no logo, no watermark.',
  // 1 — perfil
  'Turnaround reference: the exact same mascot character from the reference image, ' +
    'full profile (side) view, full body, neutral standing pose. ' +
    'Plain solid light gray background, even studio lighting, no text, no logo, no watermark.',
  // 2 — pose de fala
  'Expression reference: the exact same mascot character from the reference image, ' +
    'front view, talking pose with mouth open mid-speech and hands gesturing expressively, ' +
    'friendly and energetic. ' +
    'Plain solid light gray background, even studio lighting, no text, no logo, no watermark.',
  // 3 — segurando produto genérico
  'Action reference: the exact same mascot character from the reference image, ' +
    'front three-quarter view, cheerfully holding a plain generic unlabeled product box ' +
    'with both hands at chest height, presenting it to the camera. ' +
    'Plain solid light gray background, even studio lighting, no text, no logo, no watermark.',
];

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
 * Prompt do slot, com a descrição canônica embutida quando disponível (a
 * descrição reforça identidade: cores, estilo e do-nots entram como regras).
 * Acessórios entram como NEGATIVA (exceto no slot da caixa genérica, que já
 * tem o próprio prop) e os ajustes do usuário vêm por último, com prioridade.
 */
export function buildKitReferencePrompt(
  slot: KitReferenceSlot,
  canonicalDesc?: KitCanonicalDesc | null,
): string {
  if (!isKitReferenceSlot(slot)) {
    throw new Error(`Slot de referência inválido: ${String(slot)} (esperado 0..3)`);
  }
  const base = SLOT_PROMPTS[slot];
  if (!canonicalDesc) return base;
  const lines: string[] = [base, '', 'Character sheet (keep the character EXACTLY like this):'];
  if (canonicalDesc.traits.length > 0) lines.push(`- Traits: ${canonicalDesc.traits.join('; ')}`);
  if (canonicalDesc.colors.length > 0) lines.push(`- Colors: ${canonicalDesc.colors.join(', ')}`);
  if (canonicalDesc.style) lines.push(`- Style: ${canonicalDesc.style}`);
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
    lines.push(
      `- User adjustments (highest priority, follow strictly): ${canonicalDesc.adjustments}`,
    );
  }
  return lines.join('\n');
}
