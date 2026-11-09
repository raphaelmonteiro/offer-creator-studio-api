import { FICHA_NAVARRO, FICHA_R1, FICHA_R2 } from '../testing/reference-fichas';
import { sanitizeConcept } from './scene-reference-concept';
import {
  bodyTint,
  conceptBriefText,
  conceptEnglish,
  conceptReply,
  lightnessOf,
  mixWithWhite,
  summarize,
} from './scene-reference-summary';
import { ReferenceConcept } from './scene-reference.types';

/** A ficha do R1 com os rótulos em português que o prompt novo pede. */
function r1Concept(): {
  concept: ReferenceConcept;
  removed: ReturnType<typeof sanitizeConcept>['removed'];
} {
  const raw = JSON.parse(JSON.stringify(FICHA_R1));
  raw.theme_pt = 'festa junina';
  raw.signature_elements[0].label_pt = 'xadrez azul';
  raw.signature_elements[1].label_pt = 'bandeirinhas de São João';
  raw.palette[0].name_pt = 'azul cobalto';
  raw.palette[4].name_pt = 'marfim';
  return sanitizeConcept(raw);
}

describe('bodyTint (PV-R8)', () => {
  it('cor do corpo branca: mistura 10% da cor do cabeçalho com branco, "light"', () => {
    const tint = bodyTint({
      palette: [
        { hex: '#FFFFFF', namePt: 'branco', role: 'body background' },
        { hex: '#1739D2', namePt: 'azul', role: 'header' },
      ],
    });
    expect(tint).toEqual({
      hex: mixWithWhite('#1739D2'),
      namePt: 'azul claro',
      nameEn: 'light azul',
    });
    expect(mixWithWhite('#1739D2')).toBe('#E8EBFB');
  });

  it('cor do corpo com tinta (L* <= 94) vale como está', () => {
    const tint = bodyTint({
      palette: [{ hex: '#EADFC8', namePt: 'areia', role: 'body background' }],
    });
    expect(tint).toEqual({ hex: '#EADFC8', namePt: 'areia', nameEn: 'areia' });
  });

  it('sem cor de corpo: usa a primeira da paleta; sem paleta, marfim neutro', () => {
    expect(bodyTint({ palette: [{ hex: '#073CB8', namePt: 'azul', role: 'rays' }] }).nameEn).toBe(
      'light azul',
    );
    expect(bodyTint({ palette: [] })).toMatchObject({ hex: '#F4F1EA', nameEn: 'light ivory' });
  });

  it('mede a luminosidade: branco 100, preto 0', () => {
    expect(lightnessOf('#FFFFFF')).toBeCloseTo(100, 0);
    expect(lightnessOf('#000000')).toBeCloseTo(0, 0);
    expect(lightnessOf('#FFF4D6')).toBeGreaterThan(94);
  });
});

describe('summarize e a resposta do chat', () => {
  it('R1: resumo em pt-BR com o "Deixo de fora" das seções', () => {
    const { concept, removed } = r1Concept();
    const summary = summarize(concept, removed);
    expect(summary.theme).toBe('festa junina');
    expect(summary.uses[0]).toBe('xadrez azul no topo');
    expect(summary.uses[1]).toBe('bandeirinhas de São João no topo');
    expect(summary.uses[3]).toContain('Geometric color rays nos cantos');
    expect(summary.leftOut).toEqual(['logo, textos, preços e produtos', 'as seções de produto']);
    expect(conceptReply(summary)).toMatch(
      /^Vou usar: xadrez azul no topo, bandeirinhas de São João no topo, .*; tema festa junina; cores: azul cobalto, .*; corpo liso em azul cobalto claro\. Deixo de fora: logo, textos, preços e produtos, as seções de produto\. Posso gerar assim\? Se quiser mudar algo, use "Corrigir"\.$/,
    );
  });

  it('Navarro (D-1): cita o selo/medalhão da logo entre os descartes', () => {
    const { concept, removed } = sanitizeConcept(FICHA_NAVARRO);
    expect(summarize(concept, removed).leftOut).toContain('o selo/medalhão da logo');
  });

  it('R2 sem seção listada não cita as seções', () => {
    const raw = { ...FICHA_R2, ignored_sections: [] };
    const { concept, removed } = sanitizeConcept(raw);
    expect(summarize(concept, removed).leftOut).not.toContain('as seções de produto');
  });

  it('PV-R5: nenhum elemento sobra, o resumo diz que usa o tema e as cores', () => {
    const raw = {
      theme: 'x',
      theme_pt: 'outubro',
      signature_elements: [{ element: 'seal', where: 'header', notes: '' }],
      palette: [{ hex: '#112233', name_pt: 'azul', role: 'header' }],
    };
    const { concept, removed } = sanitizeConcept(raw);
    const reply = conceptReply(summarize(concept, removed));
    expect(reply).toContain('Sem enfeites marcantes: vou usar o tema e as cores.');
    expect(reply).toContain('Posso gerar assim?');
  });

  it('plano em inglês e item do brief', () => {
    const { concept, removed } = r1Concept();
    expect(conceptEnglish(concept)).toContain('Theme: Brazilian June festival');
    expect(conceptEnglish(concept)).toContain('Triangular paper bunting (header)');
    expect(conceptBriefText(summarize(concept, removed))).toMatch(/^Conceito do encarte: /);
  });
});
