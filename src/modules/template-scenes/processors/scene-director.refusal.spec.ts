import { decideTurn } from '../domain/scene-director-decision';
import { directorContextFor, directorReturning } from '../testing/scene-director-fixtures';
import { runDirector } from './scene-director-run';

/**
 * R62: só o par `recusa_pintado` com `refusal: painted_logo` é recusa. O par incoerente é saída inválida (validação 1),
 * e nenhum plano que chama imagem pula as validações 4, 5, 7 e 8.
 */
describe('Recusa só com o par coerente (R62)', () => {
  it('Recusa com plano de imagem é saída inválida: nenhuma imagem, e o Diretor é chamado duas vezes', async () => {
    const { director, run } = directorReturning({
      turn_kind: 'pedido_item',
      will_change_image: true,
      refusal: 'painted_logo',
      reply: 'Vou colocar a placa.',
      what_to_change: 'Add a wooden sign reading “MEGA SALE 2027” with the frame',
      exact_text: ['Oferta R$ 9,90'],
    });
    const { outcome } = await runDirector(director, {
      context: directorContextFor('coloca uma placa de madeira embaixo'),
      correlationId: 'c',
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ kind: 'unavailable', reason: 'invalid' });
  });

  it('Recusa sem classe é saída inválida: o texto da logo não é a resposta', async () => {
    const { director, run } = directorReturning({
      turn_kind: 'recusa_pintado',
      will_change_image: false,
      refusal: null,
      reply: 'Não dá.',
    });
    const { outcome } = await runDirector(director, {
      context: directorContextFor('coloca uma placa de madeira'),
      correlationId: 'c',
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ kind: 'unavailable', reason: 'invalid' });
  });

  it('O par coerente segue sendo a recusa da logo, sem refazer', async () => {
    const { director, run } = directorReturning({
      turn_kind: 'recusa_pintado',
      will_change_image: false,
      refusal: 'painted_logo',
      reply: 'Não dá.',
    });
    const { outcome } = await runDirector(director, {
      context: directorContextFor('integra a logo na imagem'),
      correlationId: 'c',
    });
    expect(run).toHaveBeenCalledTimes(1);
    if (outcome.kind !== 'plan') throw new Error(`esperava plano, veio ${outcome.kind}`);
    expect(
      decideTurn({ plan: outcome.plan, marked: false, hasImage: true, openRequests: [] }),
    ).toEqual({ kind: 'refuse', refusal: 'painted_logo' });
  });

  it('O mesmo plano de imagem sem refusal passa pelas validações: exact_text inventado vira pergunta', async () => {
    const { director } = directorReturning({
      turn_kind: 'pedido_item',
      will_change_image: true,
      refusal: null,
      reply: 'Vou colocar a placa.',
      what_to_change: 'Add a wooden sign',
      exact_text: ['Oferta R$ 9,90'],
    });
    const { outcome } = await runDirector(director, {
      context: directorContextFor('coloca uma placa de madeira embaixo'),
      correlationId: 'c',
    });
    expect(outcome.kind).toBe('exact_text_question');
  });
});
