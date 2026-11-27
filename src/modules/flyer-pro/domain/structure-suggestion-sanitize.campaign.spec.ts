import { sanitizeCampaign } from './structure-suggestion-sanitize-campaign';
import type { RawStructureSuggestion } from './structure-suggestion.types';

const campaign = (kind: RawStructureSuggestion['campaign']['kind'], label: string) => ({
  kind,
  label,
});

describe('sanitizeCampaign: a campanha lida pelo nome do encarte (Campanha lida pelo nome do encarte)', () => {
  it('Campanha de desconto: kind e label voltam como vieram', () => {
    expect(sanitizeCampaign(campaign('discount', 'Black Friday'))).toEqual({
      kind: 'discount',
      label: 'Black Friday',
    });
  });

  it('Campanha de categoria: kind e label voltam como vieram', () => {
    expect(sanitizeCampaign(campaign('category', 'Churrasco'))).toEqual({
      kind: 'category',
      label: 'Churrasco',
    });
  });

  it('Sem campanha: kind none vira null, com ou sem rótulo', () => {
    expect(sanitizeCampaign(campaign('none', ''))).toBeNull();
    expect(sanitizeCampaign(campaign('none', 'Black Friday'))).toBeNull();
  });

  it('Sem campanha: rótulo vazio ou só de espaços vira null, mesmo com kind discount ou category', () => {
    expect(sanitizeCampaign(campaign('discount', '   '))).toBeNull();
    expect(sanitizeCampaign(campaign('category', ''))).toBeNull();
  });

  it('Rótulo longo: o de 90 caracteres sai com 60, sem reticências, e o aparado vem antes do corte', () => {
    expect(sanitizeCampaign(campaign('discount', 'r'.repeat(90)))?.label).toBe('r'.repeat(60));
    expect(sanitizeCampaign(campaign('discount', `  ${'r'.repeat(59)}  `))?.label).toBe(
      'r'.repeat(59),
    );
  });

  it('o corte é por pontos de código, sem partir um emoji ao meio', () => {
    expect(sanitizeCampaign(campaign('category', '🔥'.repeat(70)))?.label).toBe('🔥'.repeat(60));
  });
});
