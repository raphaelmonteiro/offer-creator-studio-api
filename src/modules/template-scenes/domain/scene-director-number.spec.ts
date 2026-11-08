import { directorPlan } from '../testing/scene-director-fixtures';
import { applyNumberRule } from './scene-director-number';

const plan = (over: Parameters<typeof directorPlan>[0]) =>
  directorPlan({ turn_kind: 'pedido_item', will_change_image: true, ...over });

describe('Validação 7 nos blocos (D-51, R54, R55)', () => {
  it('Inventário com o ano: o item de preserve sai, sem refazer', () => {
    const result = applyNumberRule(
      plan({ what_to_change: 'more flowers', inventory_keep: ['eggs with 2027', 'the basket'] }),
      { final: false },
    );
    expect(result).toMatchObject({ kind: 'ok' });
    expect(result.kind === 'ok' && result.plan.image?.preserve).toEqual(['the basket']);
  });

  it('item de preserve com texto de metrics.paintedText fica', () => {
    const painted = ['Feliz Páscoa 2027'];
    const result = applyNumberRule(
      plan({
        what_to_change: 'more flowers',
        inventory_keep: ['the sign reading Feliz Páscoa 2027', 'the year 2027 badge'],
      }),
      { final: false, paintedText: painted },
    );
    expect(result.kind === 'ok' && result.plan.image?.preserve).toEqual([
      'the sign reading Feliz Páscoa 2027',
    ]);
  });

  it('request aberto com ano não abre, e o de remoção abre', () => {
    const requests = [
      { id: null, text: 'indicação do ano 2027', action: 'open' as const, quote: null },
      { id: null, text: 'tirar o 2027 do ovo', action: 'open' as const, quote: null },
    ];
    const result = applyNumberRule(plan({ what_to_change: 'x', requests }), { final: false });
    expect(result.kind === 'ok' && result.plan.requests.map((r) => r.text)).toEqual([
      'tirar o 2027 do ovo',
    ]);
  });

  describe('Item de requests com número a pintar abre (rodada 6, D-54)', () => {
    const open = (text: string) => [{ id: null, text, action: 'open' as const, quote: null }];
    const kept = (message: string, text: string): string[] => {
      const result = applyNumberRule(
        plan({ what_to_change: 'Remove the bunny', requests: open(text) }),
        {
          final: false,
          message,
        },
      );
      return result.kind === 'ok' ? result.plan.requests.map((request) => request.text) : [];
    };

    it('Segunda mudança com número não some: o número está entre aspas na mensagem', () => {
      const text = 'placa com a frase Feliz 2027';
      expect(kept('tira o coelho e coloca uma placa com "Feliz 2027"', text)).toEqual([text]);
      expect(kept('tira o coelho e coloca uma placa com “Feliz 2027”', text)).toEqual([text]);
    });

    it.each([
      ['tira o coelho e coloca 2027 em cima', '2027 em cima'],
      ['tira o coelho e escreve o número 99 no canto', 'número 99 no canto'],
      ['tira o coelho e põe 12/04 na placa', 'placa com 12/04'],
    ])('o número logo depois de verbo de escrever ou colocar: "%s"', (message, text) => {
      expect(kept(message, text)).toEqual([text]);
    });

    it('ano de contexto continua sem abrir item, e o número de outra mensagem não vale', () => {
      expect(kept('tira o coelho, é para o template de 2027', 'coelho para 2027')).toEqual([]);
      expect(kept('tira o coelho e coloca uma placa com "Feliz 2028"', 'placa com 2027')).toEqual(
        [],
      );
      expect(kept('tira o coelho e coloca uma placa', 'indicação do ano 2027')).toEqual([]);
    });
  });

  it('o Diretor é refeito uma vez e, persistindo, só o trecho com o número sai', () => {
    const withYear = plan({ what_to_change: 'Easter eggs and a bunny and the year 2027' });
    expect(applyNumberRule(withYear, { final: false })).toMatchObject({ kind: 'retry' });
    const final = applyNumberRule(withYear, { final: true });
    expect(final).toMatchObject({
      kind: 'ok',
      patches: [{ field: 'change', after: 'Easter eggs and a bunny' }],
    });
  });

  it('change que fica vazio vira pergunta: "O que você quer mudar na imagem?"', () => {
    const only = plan({ what_to_change: 'the year 2027' });
    expect(applyNumberRule(only, { final: true })).toEqual({ kind: 'question' });
  });

  it('exact_text é isento: o número pedido pelo cliente vai pintado', () => {
    const asked = plan({ what_to_change: 'Add the number at the top', exact_text: ['2027'] });
    const result = applyNumberRule(asked, { final: true });
    expect(result).toMatchObject({ kind: 'ok', patches: [] });
    expect(result.kind === 'ok' && result.plan.image?.exact_text).toEqual(['2027']);
  });

  it.each([
    'Make the bunny take 1/3 of the image',
    'Replace the 2027 with flowers',
    'Remove the seal and the 2027',
  ])('"%s" segue inteiro, sem refazer', (change) => {
    expect(applyNumberRule(plan({ what_to_change: change }), { final: false })).toMatchObject({
      kind: 'ok',
      patches: [],
    });
  });

  it('plano de camada, desfazer e recusa não passa pela regra', () => {
    const layer = directorPlan({ turn_kind: 'camada', what_to_change: 'ano 2027' });
    expect(applyNumberRule(layer, { final: false })).toMatchObject({ kind: 'ok', patches: [] });
  });
});
