import { directorPlan } from '../testing/scene-director-fixtures';
import { findClash } from './scene-director-clash';

const plan = (exact_text: string[]) =>
  directorPlan({
    turn_kind: 'pedido_item',
    will_change_image: true,
    exact_text,
    what_to_change: 'Add a sign',
  });
const clash = (lines: string[], message: string, known: string[] = []) =>
  findClash(plan(lines), { message, known });

describe('Duas frases para o mesmo lugar (B5, D-59)', () => {
  it('a mensagem do dono: duas frases novas e nenhum pedido de linhas separadas', () => {
    const message =
      'cria uma placa e escreve nela promoção de páscoa, e eu quero que o texto oferta de páscoa fique como se fosse parte da placa';
    expect(clash(['promoção de páscoa', 'oferta de páscoa'], message)).toEqual({
      clash: true,
      lines: ['promoção de páscoa', 'oferta de páscoa'],
    });
  });

  it.each([
    ['embaixo', 'uma placa com “Oferta de Páscoa” e embaixo “Compre já”'],
    ['abaixo', 'placa com “Oferta de Páscoa” e abaixo “Compre já”'],
    ['segunda linha', 'placa, na segunda linha “Compre já” e na primeira “Oferta de Páscoa”'],
    ['e depois', 'escreve “Oferta de Páscoa” e depois “Compre já”'],
    ['título e subtítulo', 'placa com título “Oferta de Páscoa” e subtítulo “Compre já”'],
    ['quebra de linha', 'placa com\n“Oferta de Páscoa”\n“Compre já”'],
  ])('linhas separadas pedidas (%s) não são contradição', (_n, message) => {
    expect(clash(['Oferta de Páscoa', 'Compre já'], message)).toEqual({ clash: false });
  });

  it('uma linha com preço e outra sem não disputam o mesmo lugar', () => {
    const message = 'placa com “Oferta de Páscoa” “De R$ 19,90 por R$ 9,90”';
    expect(clash(['Oferta de Páscoa', 'De R$ 19,90 por R$ 9,90'], message)).toEqual({
      clash: false,
    });
  });

  it('linha que já está pintada ou em camada não conta como frase nova', () => {
    const message = 'muda a frase da placa para Oferta de Páscoa';
    expect(
      clash(['Promoção de Páscoa', 'Oferta de Páscoa'], message, ['promoção de páscoa']),
    ).toEqual({
      clash: false,
    });
  });

  it('uma frase só não é disputa', () => {
    expect(clash(['Oferta de Páscoa'], 'coloca uma placa com Oferta de Páscoa')).toEqual({
      clash: false,
    });
  });
});
