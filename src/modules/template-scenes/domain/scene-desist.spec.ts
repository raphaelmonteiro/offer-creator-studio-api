import { BriefItem } from './scene-brief';
import { isGenericDesist, resolveGenericDrops } from './scene-desist';
import { DirectorPlan } from './scene-director-schema';
import { directorPlan } from '../testing/scene-director-fixtures';

const item = (id: string, text: string, status: BriefItem['status'] = 'open'): BriefItem => ({
  id,
  text,
  status,
  sourceMessageId: 'm',
  updatedAt: '2026-11-06T12:00:00.000Z',
});
const dropPlan = (id: string | null, quote = 'esquece isso', text = 'rio'): DirectorPlan =>
  directorPlan({
    turn_kind: 'outro',
    requests: [{ id, text, action: 'drop', quote }],
  });

describe('desistência genérica', () => {
  it.each([
    'esquece isso',
    'esquece',
    'deixa pra la',
    'deixa isso pra lá',
    'desisto',
    'não precisa',
    'não quero mais',
  ])('"%s" é genérica', (quote) => {
    expect(isGenericDesist(quote)).toBe(true);
  });

  it.each(['de', 'muda a cor de fundo', 'quero um rio', ''])('"%s" não é', (quote) => {
    expect(isGenericDesist(quote)).toBe(false);
  });
});

describe('resolveGenericDrops: o alvo de "esquece isso"', () => {
  it('Esquece isso com um item em aberto: o alvo é o único item', () => {
    const result = resolveGenericDrops(dropPlan(null), [item('p1', 'rio')]);
    expect(result).toMatchObject({
      kind: 'ok',
      plan: { requests: [{ id: 'p1', action: 'drop' }] },
    });
  });

  it('Esquece isso refere-se ao mais recente: o id do Diretor é o último aberto', () => {
    const brief = [item('p1', 'coelho'), item('p2', 'rio')];
    const result = resolveGenericDrops(dropPlan('p2', 'deixa pra la'), brief);
    expect(result).toMatchObject({ kind: 'ok', plan: { requests: [{ id: 'p2' }] } });
  });

  it.each([
    ['o id do Diretor é o item mais antigo', 'p1'],
    ['sem id', null],
  ])(
    'Esquece isso com alvo incerto (%s): nada desiste e pergunta, citando os dois',
    (_name, id) => {
      const brief = [item('p1', 'coelho'), item('p2', 'rio')];
      expect(resolveGenericDrops(dropPlan(id), brief)).toEqual({
        kind: 'ask',
        items: ['coelho', 'rio'],
      });
    },
  );

  it('sem item em aberto, não há o que esquecer', () => {
    expect(resolveGenericDrops(dropPlan('p1'), [item('p1', 'rio', 'done')])).toEqual({
      kind: 'none',
    });
  });

  it('desistência com palavra do item não passa pela resolução genérica', () => {
    const plan = dropPlan('p1', 'esquece o rio');
    expect(resolveGenericDrops(plan, [item('p1', 'rio'), item('p2', 'coelho')])).toEqual({
      kind: 'ok',
      plan,
    });
  });

  it('itens feitos ou desistidos não contam como alvo', () => {
    const brief = [item('p1', 'coelho', 'done'), item('p2', 'rio')];
    expect(resolveGenericDrops(dropPlan(null), brief)).toMatchObject({
      kind: 'ok',
      plan: { requests: [{ id: 'p2' }] },
    });
  });
});
