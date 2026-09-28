import { ProductMetadata } from '../metadata/product-metadata.schema';
import { montarIndice } from './ean-candidate.service';
import type { EanCandidateRecord } from './ean-match.types';
import { aplicarVetos } from './ean-veto';
import { Gs1PrefixMap } from './gs1-prefix-map';

function row(
  id: string,
  filename: string,
  brand: string,
  quantity: { value: number; unit: string } | null,
) {
  return {
    id,
    filename,
    url: `/u/${id}`,
    metadata: {
      title: filename,
      quantity,
      alternatives: [{ brand, subBrand: null, variant: null }],
      ean: null,
    } as unknown as ProductMetadata,
  };
}

function cand(id: string, brand: string): EanCandidateRecord {
  return {
    imageId: id,
    filename: id,
    url: '',
    title: null,
    brand,
    variant: null,
    quantity: null,
    score: 0.5,
    textScore: 0.5,
    vectorScore: null,
    origins: ['brand'],
    vetoes: [],
  };
}

describe('aplicarVetos', () => {
  const indice = montarIndice([
    row('aviacao-200', 'Aviacao - copo 200g.png', 'Aviação', { value: 200, unit: 'g' }),
    row('aviacao-180', 'Aviacao - copo 180g.png', 'Aviação', { value: 180, unit: 'g' }),
    row('aviacao-sem-qtd', 'Aviacao.png', 'Aviação', null),
    row('heinz-picles', 'Heinz - picles 397g.png', 'Heinz', { value: 397, unit: 'g' }),
    row('quero-ketchup', 'Quero - ketchup 397g.png', 'Quero', { value: 397, unit: 'g' }),
  ]);
  const vazio = new Gs1PrefixMap();

  it('veta gramatura divergente (180g × 200g) e registra o motivo', () => {
    const cs = ['aviacao-200', 'aviacao-180', 'aviacao-sem-qtd'].map((id) => cand(id, 'Aviação'));
    const vivas = aplicarVetos(
      'REQUEIJAO CREMOSO AVIACAO 180GR COPO',
      '7896051100010',
      cs,
      indice.porId,
      vazio,
    );

    expect(vivas.map((c) => c.imageId)).toEqual(['aviacao-180', 'aviacao-sem-qtd']);
    expect(cs[0].vetoes).toEqual([{ reason: 'quantity', detail: 'planilha 180g × imagem 200g' }]);
  });

  it('ausência de quantidade na imagem não veta', () => {
    const cs = [cand('aviacao-sem-qtd', 'Aviação')];
    expect(
      aplicarVetos('REQUEIJAO AVIACAO 180GR', '7896051100010', cs, indice.porId, vazio),
    ).toHaveLength(1);
  });

  it('veta marca incoerente com o prefixo GS1 do EAN', () => {
    const mapa = new Gs1PrefixMap();
    for (const g of ['7896102503722', '7896102500011', '7896102500028']) mapa.add(g, 'Heinz');
    const cs = [cand('heinz-picles', 'Heinz'), cand('quero-ketchup', 'Quero')];
    const vivas = aplicarVetos('KETCHUP 397G', '7896102509990', cs, indice.porId, mapa);

    expect(vivas.map((c) => c.imageId)).toEqual(['heinz-picles']);
    expect(cs[1].vetoes[0].reason).toBe('gs1-prefix');
  });

  it('todas vetadas: nenhuma sobrevive, todas com motivo', () => {
    const cs = [cand('aviacao-200', 'Aviação')];
    const vivas = aplicarVetos('REQUEIJAO AVIACAO 180GR', '7896051100010', cs, indice.porId, vazio);
    expect(vivas).toHaveLength(0);
    expect(cs[0].vetoes.length).toBeGreaterThan(0);
  });
});
