import { BriefItem } from '../domain/scene-brief';
import { briefBlock, paintedBlock, paintedLinesOf, paintedTextOf } from './scene-director-blocks';

describe('Texto pintado no contexto do Diretor', () => {
  it('as linhas vêm com zona e marca; a forma antiga, só com o texto, também vale', () => {
    const version = {
      metrics: {
        paintedText: [
          'Frete grátis',
          { text: 'Promoção de Páscoa', zone: 'footer' },
          { text: 'Oferta', zone: 'footer', unchecked: true },
          { text: 'Zona inventada', zone: 'cima' },
          { zone: 'footer' },
          7,
        ],
      },
    };
    expect(paintedLinesOf(version)).toEqual([
      { text: 'Frete grátis' },
      { text: 'Promoção de Páscoa', zone: 'footer' },
      { text: 'Oferta', zone: 'footer', unchecked: true },
      { text: 'Zona inventada' },
    ]);
    expect(paintedTextOf(version)).toEqual([
      'Frete grátis',
      'Promoção de Páscoa',
      'Oferta',
      'Zona inventada',
    ]);
  });

  it('o bloco cita as linhas e marca a que não foi conferida', () => {
    expect(
      paintedBlock([{ text: 'Promoção de Páscoa' }, { text: 'Oferta', unchecked: true }]),
    ).toBe(
      'Textos já pintados na imagem atual (cite sem inventar): “Promoção de Páscoa” / “Oferta” (não conferido)',
    );
    expect(paintedBlock([])).toBe('Textos já pintados na imagem atual: nenhum.');
  });
});

describe('Pedidos no contexto do Diretor (D-59)', () => {
  const item = (id: string, status: BriefItem['status'], text: string): BriefItem => ({
    id,
    text,
    status,
    sourceMessageId: 'm0',
    updatedAt: '2026-11-08T12:00:00.000Z',
  });

  it('o item em aberto vem como do turno anterior, o feito e o desistido como contexto, e o superado não vem', () => {
    const block = briefBlock([
      item('p1', 'open', 'um rio no meio'),
      item('p2', 'done', 'placa vazia'),
      item('p3', 'dropped', 'borboleta'),
      item('p4', 'superseded', 'trator vermelho'),
    ]);
    expect(block).toContain('em aberto, do turno anterior');
    expect(block).toContain('- p1: um rio no meio');
    expect(block).toContain('- p2 (feito): placa vazia');
    expect(block).toContain('- p3 (desistido): borboleta');
    expect(block).not.toContain('trator');
  });

  it('sem item em aberto, diz nenhum', () => {
    expect(briefBlock([item('p4', 'superseded', 'trator vermelho')])).toBe(
      'Pedidos do cliente em aberto, do turno anterior: nenhum.',
    );
  });
});
