import { randomUUID } from 'crypto';
import { nestedErrorsOf } from './dto-paths.testutil';
import { StartEnrichmentDto } from './start-enrichment.dto';

const errorsOf = (body: Record<string, unknown>) => nestedErrorsOf(StartEnrichmentDto, body);
const uuids = (count: number) => Array.from({ length: count }, () => randomUUID());

describe('StartEnrichmentDto (N14)', () => {
  describe('forma do pedido do job', () => {
    it('aceita só steps, e o pedido completo', async () => {
      expect(await errorsOf({ steps: ['image_match'] })).toEqual([]);
      expect(
        await errorsOf({
          steps: ['categorize', 'spellcheck', 'image_match'],
          itemIds: uuids(2),
          onlyMissing: false,
          autoApply: false,
        }),
      ).toEqual([]);
    });

    it('corpo vazio: steps é recusado (o pipe global pula o {} e o serviço confere à mão)', async () => {
      expect(await errorsOf({})).toEqual(['steps']);
    });

    it.each([
      ['lista vazia', []],
      ['valor repetido', ['image_match', 'image_match']],
      ['fase desconhecida', ['translate']],
      ['não é lista', 'image_match'],
      ['fase desconhecida no meio de fases válidas', ['categorize', 'translate']],
    ])('steps com %s: 400', async (_, steps) => {
      expect(await errorsOf({ steps })).toEqual(['steps']);
    });

    it('itemIds com 500 UUIDs passa; com 501, 400', async () => {
      expect(await errorsOf({ steps: ['image_match'], itemIds: uuids(500) })).toEqual([]);
      expect(await errorsOf({ steps: ['image_match'], itemIds: uuids(501) })).toEqual(['itemIds']);
    });

    it.each([
      ['id que não é UUID', ['abc']],
      ['não é lista', 'a1b2'],
      ['item que não é texto', [1]],
    ])('itemIds com %s: 400', async (_, itemIds) => {
      expect(await errorsOf({ steps: ['image_match'], itemIds })).toEqual(['itemIds']);
    });

    it('itemIds vazio é aceito pela forma (o serviço responde 422 de escopo vazio)', async () => {
      expect(await errorsOf({ steps: ['image_match'], itemIds: [] })).toEqual([]);
    });

    it.each([
      ['onlyMissing', 'sim'],
      ['onlyMissing', 1],
      ['autoApply', 'false'],
      ['autoApply', 0],
    ])('%s=%p não é booleano: 400', async (field, value) => {
      expect(await errorsOf({ steps: ['image_match'], [field]: value })).toEqual([field]);
    });

    it('campo desconhecido: 400', async () => {
      expect(await errorsOf({ steps: ['spellcheck'], priority: 1 })).toEqual(['priority']);
    });
  });

  describe('nulo no pedido do job (A-28, L-24)', () => {
    it('itemIds nulo vale "todos": a forma aceita', async () => {
      expect(await errorsOf({ steps: ['image_match'], itemIds: null })).toEqual([]);
    });

    it.each([
      ['steps', { steps: null }],
      ['onlyMissing', { steps: ['image_match'], onlyMissing: null }],
      ['autoApply', { steps: ['image_match'], autoApply: null }],
    ])('%s nulo: 400, e nunca vale o padrão', async (field, body) => {
      expect(await errorsOf(body)).toEqual([field]);
    });

    it('os três nulos juntos: os três campos recusados', async () => {
      expect(
        await errorsOf({ steps: null, onlyMissing: null, autoApply: null, itemIds: null }),
      ).toEqual(['steps', 'onlyMissing', 'autoApply']);
    });
  });
});
