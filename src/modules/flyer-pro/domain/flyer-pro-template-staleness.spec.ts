import { compareFaces } from './flyer-pro-template-staleness';

const face = (key: string, pictorialKey = `p-${key}`, fingerprint = `f-${key}`) =>
  ({
    key,
    pictorialKey,
    fingerprint,
  }) as Parameters<typeof compareFaces>[0][number];

describe('compareFaces: a cópia contra a cena de hoje, por fingerprint e pictorialKey', () => {
  it('iguais: não está desatualizada', () => {
    expect(compareFaces([face('front'), face('back')], [face('front'), face('back')])).toEqual({
      stale: false,
      staleKind: null,
    });
  });

  it('a ordem das faces não importa: a comparação é pela key', () => {
    expect(compareFaces([face('front'), face('back')], [face('back'), face('front')])).toEqual({
      stale: false,
      staleKind: null,
    });
  });

  it('imagem nova (pictorialKey e fingerprint mudam): art', () => {
    expect(compareFaces([face('single')], [face('single', 'p-novo', 'f-novo')])).toEqual({
      stale: true,
      staleKind: 'art',
    });
  });

  it('só o nome ou só uma camada (só o fingerprint muda): layers', () => {
    expect(compareFaces([face('single')], [face('single', 'p-single', 'f-novo')])).toEqual({
      stale: true,
      staleKind: 'layers',
    });
  });

  it('imagem de uma face e camada da outra: art prevalece', () => {
    const copy = [face('front'), face('back')];
    const today = [face('front', 'p-novo', 'f-novo'), face('back', 'p-back', 'f-novo')];
    expect(compareFaces(copy, today)).toEqual({ stale: true, staleKind: 'art' });
    expect(compareFaces(copy, [...today].reverse())).toEqual({ stale: true, staleKind: 'art' });
  });

  it('face a menos hoje (a cópia tem duas): art', () => {
    expect(compareFaces([face('front'), face('back')], [face('front')])).toEqual({
      stale: true,
      staleKind: 'art',
    });
  });

  it('face a mais hoje (a cópia tem uma): art', () => {
    expect(compareFaces([face('front')], [face('front'), face('back')])).toEqual({
      stale: true,
      staleKind: 'art',
    });
  });

  it('conjunto trocado, com o mesmo tamanho: art', () => {
    expect(compareFaces([face('front')], [face('back')])).toEqual({
      stale: true,
      staleKind: 'art',
    });
  });

  it('cena sem face pronta hoje: art', () => {
    expect(compareFaces([face('single')], [])).toEqual({ stale: true, staleKind: 'art' });
  });
});
