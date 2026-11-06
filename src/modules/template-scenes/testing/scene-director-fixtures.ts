import { DirectorPlan } from '../domain/scene-director-schema';

/** Plano válido mínimo do Diretor (pergunta sem mudança); os testes sobrescrevem o que importa. */
export function directorPlan(overrides: Partial<DirectorPlan> = {}): DirectorPlan {
  return {
    turn_kind: 'pergunta',
    will_change_image: false,
    reply: 'Vejo um campo florido.',
    what_to_change: '',
    what_to_put: '',
    inventory_keep: [],
    what_i_see: 'Um campo florido com ovos e uma cesta.',
    undo_target: null,
    layer_ops: [],
    requests: [],
    refusal: null,
    written_content: [],
    ...overrides,
  };
}

export const directorRaw = (overrides: Partial<DirectorPlan> = {}): string =>
  JSON.stringify(directorPlan(overrides));
