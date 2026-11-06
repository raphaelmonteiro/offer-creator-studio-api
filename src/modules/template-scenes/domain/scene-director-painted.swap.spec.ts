import { directorPlan } from '../testing/scene-director-fixtures';
import { checkPainted } from './scene-director-painted';

describe('Troca de objeto e o que o plano manda tirar (task 1.42)', () => {
  const plan = (what_to_change: string, what_to_put: string) =>
    directorPlan({
      turn_kind: 'pedido_item',
      will_change_image: true,
      what_to_change,
      what_to_put,
    });

  it.each([
    ['Remover o título da parte superior', 'Flores na área onde está o título'],
    ['Remover o título da parte superior central.', 'Flores no lugar do título.'],
    ['Remover o título no alto da imagem.', 'Flores na parte de cima, onde estava o título'],
    ['troca o título por flores', 'flores na área do título'],
    ['Remover o título da parte superior', 'Flores cobrindo o título'],
  ])('Troca do título por um objeto: "%s" + "%s" segue, sem refazer', (change, put) => {
    const p = plan(change, put);
    expect(checkPainted(p, { final: false })).toEqual({ kind: 'ok', plan: p });
  });

  it.each([
    ['Remover o título', 'outro título'],
    ['Remover o título', 'um novo título'],
    ['Remover o título', 'um título decorativo'],
    ['Remover o coelho', 'o título'],
  ])(
    'Troca do título por outro título: "%s" + "%s" refaz e, persistindo, pergunta',
    (change, put) => {
      const p = plan(change, put);
      expect(checkPainted(p, { final: false })).toMatchObject({ kind: 'retry' });
      expect(checkPainted(p, { final: true })).toEqual({ kind: 'question' });
    },
  );

  it('o termo precisa ser o que sai: remover o coelho não libera "o título" no what_to_put', () => {
    const p = plan('Remover o coelho', 'Flores com o título');
    expect(checkPainted(p, { final: true })).toEqual({ kind: 'question' });
  });

  it('o artigo definido sozinho não basta: "Flores cobrindo o título" sem remover o título é dúvida', () => {
    const p = plan('Colocar flores no alto', 'Flores cobrindo o título');
    expect(checkPainted(p, { final: true })).toEqual({ kind: 'question' });
  });

  it.each([
    'Flores no lugar do título',
    'Flores em vez do título',
    'Flores onde está o título',
    'Flores na área do título',
  ])(
    'lugar novo na referência: "%s" no what_to_put não é pedido de escrita, mesmo sem remover o título',
    (put) => {
      const p = plan('Colocar flores no alto', put);
      expect(checkPainted(p, { final: false })).toEqual({ kind: 'ok', plan: p });
    },
  );

  it('só vale para termo solto: "troca o título por PROMOÇÃO" continua recusa', () => {
    const p = plan('troca o título por PROMOÇÃO', '');
    expect(checkPainted(p, { final: false })).toMatchObject({
      kind: 'ok',
      plan: { turn_kind: 'recusa_pintado' },
    });
  });

  it.each([
    [
      'Troca de objeto que não é texto',
      'troca o coelho por um gato',
      'Um gato sentado no lugar do coelho, no mesmo estilo aquarelado',
    ],
    [
      'Troca de objeto que não é texto',
      'troca a cesta por uma caixa',
      'Uma caixa de presente no lugar da cesta',
    ],
    [
      'Troca de objeto que não é texto',
      'troca o ovo por uma bola',
      'Uma bola colorida no lugar do ovo',
    ],
    [
      'Troca de objeto que não é texto',
      'troca a flor por uma folha',
      'Uma folha verde onde estava a flor',
    ],
  ])('%s: "%s" segue, sem recusa e sem pergunta de escrita', (_n, change, put) => {
    const p = plan(change, put);
    expect(checkPainted(p, { final: false })).toEqual({ kind: 'ok', plan: p });
  });
});
