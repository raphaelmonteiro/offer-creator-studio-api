import { nestedErrorsOf } from './dto-paths.testutil';
import { SaveFlyerProDocumentDto } from './save-flyer-pro-document.dto';

const VALID = {
  mutationId: 'c0a8012e-6f4b-4b7e-9d7a-0e2f5a1b3c4d',
  expectedRevision: 38,
  schemaVersion: 1,
  engineVersion: 1,
};

const errorsOf = (body: Record<string, unknown>) =>
  nestedErrorsOf(SaveFlyerProDocumentDto, { ...VALID, ...body });

describe('SaveFlyerProDocumentDto: campo enrich (N4)', () => {
  it('aceita enrich com as três fases e com uma só, junto de outros ramos do corpo', async () => {
    expect(
      await errorsOf({ enrich: { steps: ['categorize', 'spellcheck', 'image_match'] } }),
    ).toEqual([]);
    expect(await errorsOf({ slices: { card: {} }, enrich: { steps: ['image_match'] } })).toEqual(
      [],
    );
  });

  describe('forma do campo enrich', () => {
    it('chave a mais no enrich: 400 e nada é gravado', async () => {
      expect(await errorsOf({ enrich: { steps: ['image_match'], onlyMissing: false } })).toEqual([
        'enrich.onlyMissing',
      ]);
    });

    it.each([
      ['steps vazio', { steps: [] }],
      ['steps repetido', { steps: ['image_match', 'image_match'] }],
      ['fase desconhecida', { steps: ['translate'] }],
      ['sem steps', {}],
    ])('%s: 400', async (_, enrich) => {
      expect(await errorsOf({ enrich })).toEqual(['enrich.steps']);
    });

    it('enrich que não é objeto: 400', async () => {
      expect(await errorsOf({ enrich: 'image_match' })).toEqual(['enrich']);
      expect(await errorsOf({ enrich: ['image_match'] })).toEqual(['enrich.0']);
    });
  });

  describe('enrich nulo (A-28, L-24)', () => {
    it('enrich: null é 400, e não vale como enrich ausente', async () => {
      expect(await errorsOf({ slices: { card: {} }, enrich: null })).toEqual(['enrich']);
    });

    it('enrich: { steps: null } é 400, como "não é lista"', async () => {
      expect(await errorsOf({ enrich: { steps: null } })).toEqual(['enrich.steps']);
    });

    it('o mesmo corpo reenviado com o mesmo mutationId é recusado de novo (o pipe roda antes do serviço)', async () => {
      const body = { slices: { card: {} }, enrich: null };

      expect(await errorsOf(body)).toEqual(['enrich']);
      expect(await errorsOf(body)).toEqual(['enrich']);
    });
  });

  it('enrich ausente continua válido', async () => {
    expect(await errorsOf({ slices: { card: {} } })).toEqual([]);
  });
});
