import { directorPlan } from '../testing/scene-director-fixtures';
import { checkComposition } from './scene-director-composition';
import { DIRECTOR_INSTRUCTIONS } from './scene-director-prompt';

/**
 * R67: o exemplo de ancoragem do prompt do Diretor não pode usar termo de divisão que a validação 5 barra, senão o
 * Diretor recebe duas ordens contrárias e um pedido normal vira pergunta de composição.
 */
describe('Exemplos do prompt do Diretor passam pela validação 5 (R67)', () => {
  const rule =
    DIRECTOR_INSTRUCTIONS.split('\n').find((line) => line.includes('ancore o objeto')) ?? '';
  const examples = [...rule.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

  it('a regra de ancoragem existe e traz exemplos entre aspas', () => {
    expect(rule).not.toBe('');
    expect(examples.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ['embaixo', 'coloca uma placa de madeira embaixo'],
    ['em cima', 'coloca uma placa de madeira em cima'],
  ])('com a mensagem "%s" sem termo de divisão, nenhum exemplo é barrado', (_name, message) => {
    for (const example of examples) {
      const plan = directorPlan({
        turn_kind: 'pedido_item',
        will_change_image: true,
        what_to_change: `Add a wooden sign ${example}`,
      });
      expect(checkComposition(plan, [message])).toEqual({ ok: true });
    }
  });
});
