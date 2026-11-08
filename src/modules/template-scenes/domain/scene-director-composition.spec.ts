import { directorPlan } from '../testing/scene-director-fixtures';
import { checkComposition, clientAsksForSplit } from './scene-director-composition';

describe('checkComposition: Composição só do cliente', () => {
  describe('Cliente falou em header e rodapé', () => {
    it('o plano com "bordas superior e inferior" segue, sem refazer e sem texto removido', () => {
      const phrase = 'concentrando a decoração nas bordas superior e inferior';
      const plan = directorPlan({
        turn_kind: 'pedido_composicao',
        will_change_image: true,
        what_to_change: `reorganizar os coelhos, ${phrase}`,
      });
      const before = structuredClone(plan);

      expect(checkComposition(plan, ['coelhos no roda pé e outros no header'])).toEqual({
        ok: true,
      });
      expect(plan).toEqual(before);
      expect(plan.image?.change).toContain(phrase);
    });

    it.each(['cabeçalho', 'header', 'rodapé', 'footer', 'topo'])(
      '"%s" autoriza borda, faixa, banner e topo',
      (word) => {
        const plan = directorPlan({ what_to_put: 'uma faixa e um banner na borda e no topo' });
        expect(checkComposition(plan, [`decora o ${word}`])).toEqual({ ok: true });
      },
    );
  });

  describe('Moldura que ninguém pediu', () => {
    it('recusa e devolve o grupo e o motivo, sem alterar o plano', () => {
      const plan = directorPlan({
        will_change_image: true,
        what_to_put: 'enquadrar como uma moldura',
      });
      const result = checkComposition(plan, ['quero um campo florido', 'mais coelhos']);
      expect(result).toMatchObject({ ok: false, groups: ['moldura'] });
      expect(plan.image?.change).toBe('enquadrar como uma moldura');
    });

    it('moldura só autoriza a si mesma: cabeçalho não libera moldura', () => {
      const plan = directorPlan({ what_to_put: 'emoldurar o cabeçalho' });
      expect(checkComposition(plan, ['decora o cabeçalho'])).toMatchObject({
        ok: false,
        groups: ['moldura'],
      });
      expect(checkComposition(plan, ['decora o cabeçalho com moldura'])).toEqual({ ok: true });
    });

    it('confere todos os campos: o inventário também conta', () => {
      const plan = directorPlan({ inventory_keep: ['coelho', 'faixa vermelha'] });
      expect(checkComposition(plan, ['tira o coelho'])).toMatchObject({
        ok: false,
        groups: ['faixa'],
      });
    });
  });

  describe('Refeito com sucesso', () => {
    it('o segundo plano sem o termo passa', () => {
      const first = directorPlan({ what_to_put: 'uma faixa de ovos' });
      const second = directorPlan({ what_to_put: 'ovos espalhados' });
      expect(checkComposition(first, ['mais ovos']).ok).toBe(false);
      expect(checkComposition(second, ['mais ovos']).ok).toBe(true);
    });
  });

  describe('Cada grupo do anexo', () => {
    it.each([
      ['divisao', 'duas divisões na imagem'],
      ['divisao', 'um painel azul'],
      ['divisao', 'três colunas'],
      ['margem', 'margens largas'],
      ['espaco', 'deixar área livre para o texto'],
      ['borda', 'uma beirada de flores'],
    ])('%s: "%s" sem pedido do cliente é barrado', (group, text) => {
      expect(checkComposition(directorPlan({ what_to_put: text }), ['mais flores'])).toMatchObject({
        ok: false,
        groups: [group],
      });
    });

    it('palavra parecida não casa: "bordado" e "quadrado" passam', () => {
      const plan = directorPlan({ what_to_put: 'uma toalha bordada com desenho quadrado' });
      expect(checkComposition(plan, ['mais flores'])).toEqual({ ok: true });
    });

    it('sem termos no plano nada é conferido', () => {
      expect(checkComposition(directorPlan(), [])).toEqual({ ok: true });
    });
  });
});

describe('clientAsksForSplit (D-43)', () => {
  it.each([
    ['divide em duas partes, azul em cima e verde embaixo', true],
    ['coloca uma moldura', true],
    ['uma faixa de flores', true],
    ['ovos no rodapé e coelho no cabeçalho', false],
    ['template de pascoa para 2027', false],
  ])('"%s" → %s', (message, expected) => {
    expect(clientAsksForSplit(['quero um template', message])).toBe(expected);
  });
});

describe('checkComposition em requests (R4)', () => {
  const withRequest = (text: string, action: 'open' | 'drop' = 'open') =>
    directorPlan({
      turn_kind: 'pedido_item',
      will_change_image: true,
      what_to_change: 'colocar um coelho',
      requests: [{ id: null, text, action, quote: action === 'drop' ? 'x' : null }],
    });

  it('moldura que ninguém pediu em requests aberto é recusada, como nos outros campos', () => {
    const check = checkComposition(withRequest('coelho com moldura dourada'), ['coloca um coelho']);
    expect(check).toMatchObject({ ok: false, groups: ['moldura'] });
  });

  it('o cliente que pediu a moldura autoriza o pedido', () => {
    const check = checkComposition(withRequest('coelho com moldura dourada'), [
      'coloca um coelho com moldura dourada',
    ]);
    expect(check).toEqual({ ok: true });
  });

  it('requests com drop não vai ao prompt e não é conferido', () => {
    const check = checkComposition(withRequest('moldura', 'drop'), ['esquece a moldura']);
    expect(check).toEqual({ ok: true });
  });
});
