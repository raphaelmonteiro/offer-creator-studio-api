import { DirectorImage, DirectorPlan } from './scene-director-schema';

/** Os campos de texto livre de `image` que vão ao prompt (todos menos `exact_text`, que é bloco do código). */
export type ImageTextField = 'composition' | 'style' | 'change';

/** Bloco de imagem vazio, na região inteira: base do plano que o código monta ("marquei", D-54). */
export function emptyImage(overrides: Partial<DirectorImage> = {}): DirectorImage {
  return {
    composition: '',
    style: '',
    change: '',
    region: { zone: 'whole', side: null },
    preserve: [],
    exact_text: [],
    ...overrides,
  };
}

/** A mudança desta rodada em uma linha, sem pontuação final; vazia se o plano não traz imagem. */
export function imageChange(plan: Pick<DirectorPlan, 'image'>): string {
  return (plan.image?.change ?? '').replace(/\s+/g, ' ').trim();
}

/** O plano com os blocos de imagem trocados. */
export function withImage(plan: DirectorPlan, image: DirectorImage): DirectorPlan {
  return { ...plan, image };
}
