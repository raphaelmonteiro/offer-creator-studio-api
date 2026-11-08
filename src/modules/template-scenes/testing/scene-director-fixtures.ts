import { DirectorImage, DirectorPlan } from '../domain/scene-director-schema';
import { DirectorContext } from '../services/scene-director-context';
import { SceneDirectorService } from '../services/scene-director.service';

/** Blocos de imagem válidos mínimos (D-51); os testes sobrescrevem o que importa. */
export function directorImage(overrides: Partial<DirectorImage> = {}): DirectorImage {
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

/**
 * Atalhos de teste para os blocos de `image`: `what_to_change` e `what_to_put` viram `image.change`, e
 * `inventory_keep` vira `image.preserve`. Só existem aqui; o schema do Diretor não tem esses campos.
 */
export interface PlanShortcuts {
  what_to_change?: string;
  what_to_put?: string;
  inventory_keep?: string[];
  exact_text?: string[];
}

export type PlanOverrides = Partial<DirectorPlan> & PlanShortcuts;

/** Plano válido mínimo do Diretor (pergunta sem mudança); os testes sobrescrevem o que importa. */
export function directorPlan(overrides: PlanOverrides = {}): DirectorPlan {
  const { what_to_change, what_to_put, inventory_keep, exact_text, ...rest } = overrides;
  const change = [what_to_change, what_to_put].filter(Boolean).join('; ');
  const hasBlocks = change || inventory_keep?.length || exact_text?.length;
  return {
    turn_kind: 'pergunta',
    will_change_image: false,
    reply: 'Vejo um campo florido.',
    image: hasBlocks
      ? directorImage({ change, preserve: inventory_keep ?? [], exact_text: exact_text ?? [] })
      : null,
    what_i_see: 'Um campo florido com ovos e uma cesta.',
    undo_target: null,
    layer_ops: [],
    requests: [],
    refusal: null,
    ...rest,
  } as DirectorPlan;
}

export const directorRaw = (overrides: PlanOverrides = {}): string =>
  JSON.stringify(directorPlan(overrides));

/** Contexto mínimo do Diretor para a mensagem, com uma cena que já tem imagem; os testes trocam o que importa. */
export const directorContextFor = (
  message: string,
  over: Partial<DirectorContext> = {},
): DirectorContext => ({
  text: '',
  image: null,
  script: {
    message,
    hasImage: true,
    marked: false,
    openRequests: [],
    layers: [],
    hasLogoAttachment: false,
  },
  clientMessages: [message],
  briefItems: [],
  paintedText: [],
  layerTexts: [],
  layerNames: [],
  ...over,
});

/** Diretor simulado que devolve sempre o mesmo plano, com o `run` espiável. */
export const directorReturning = (plan: PlanOverrides) => {
  const run = jest.fn().mockResolvedValue({
    ok: true,
    text: JSON.stringify(directorPlan(plan)),
    costUsd: 0.0004,
    requestId: 'req',
    latencyMs: 5,
  });
  return { director: { run } as unknown as SceneDirectorService, run };
};
