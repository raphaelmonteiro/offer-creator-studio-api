import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { nestedErrorsOf } from './dto-paths.testutil';
import { SaveFlyerProDocumentDto } from './save-flyer-pro-document.dto';

const VALID = {
  mutationId: 'c0a8012e-6f4b-4b7e-9d7a-0e2f5a1b3c4d',
  expectedRevision: 37,
  schemaVersion: 1,
  engineVersion: 1,
};

/** As propriedades recusadas, com o mesmo `whitelist` e `forbidNonWhitelisted` do pipe global. */
async function errorsOf(body: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(SaveFlyerProDocumentDto, { ...VALID, ...body });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((error) => error.property);
}

describe('SaveFlyerProDocumentDto', () => {
  it('aceita o corpo só com os quatro obrigatórios e o corpo com tudo', async () => {
    expect(await errorsOf({})).toEqual([]);
    expect(
      await errorsOf({
        layoutDigest: 'a41b07c9e2d35f18',
        renderDigest: '0c9d55e1a7b34f02',
        layoutSnapshot: { engineVersion: 1 },
        setup: { name: 'Ofertas', pageCount: 4, refreshTemplate: false },
        slices: { frame: {}, structure: {}, card: {}, assembly: {}, exportPrefs: {} },
        items: { upsert: [], delete: [], replaceAll: false },
      }),
    ).toEqual([]);
  });

  it.each([
    ['mutationId', 'abc'],
    ['expectedRevision', -1],
    ['expectedRevision', 1.5],
    ['schemaVersion', 0],
    ['engineVersion', 0],
    ['schemaVersion', 2147483648],
    ['engineVersion', 2147483648],
    ['layoutDigest', 'x'.repeat(65)],
    ['layoutDigest', ''],
    ['renderDigest', 'x'.repeat(65)],
    ['layoutSnapshot', [1]],
    ['layoutSnapshot', 'texto'],
  ])('recusa %s=%p', async (field, value) => {
    expect(await errorsOf({ [field]: value })).toEqual([field]);
  });

  it('aceita expectedRevision 0 e os extremos das versões', async () => {
    expect(await errorsOf({ expectedRevision: 0, schemaVersion: 2147483647 })).toEqual([]);
  });

  it('campo desconhecido é recusado', async () => {
    expect(await errorsOf({ foo: 1 })).toEqual(['foo']);
  });

  it('import é opcional; a forma dele está em flyer-pro-import.dto.spec.ts, e o objeto vazio é recusado', async () => {
    expect(await errorsOf({ import: {} })).toEqual(['import']);
    expect(await errorsOf({ import: null })).toEqual(['import']);
  });

  describe('slices', () => {
    it('fatia fora da lista é recusada', async () => {
      expect(await errorsOf({ slices: { foo: {} } })).toEqual(['slices']);
    });

    it('fatia que é lista ou texto é recusada', async () => {
      expect(await errorsOf({ slices: { card: [1] } })).toEqual(['slices']);
      expect(await errorsOf({ slices: { frame: 'x' } })).toEqual(['slices']);
    });

    it.each(['frame', 'structure', 'card', 'assembly', 'exportPrefs'])(
      'fatia %s nula é recusada (400), não vira NULL na coluna NOT NULL',
      async (key) => {
        expect(await errorsOf({ slices: { [key]: null } })).toEqual(['slices']);
      },
    );

    it('o conteúdo da fatia não é conferido', async () => {
      expect(await errorsOf({ slices: { card: { qualquer: [1, { a: null }] } } })).toEqual([]);
    });
  });

  it.each(['setup', 'slices', 'items'])(
    '%s nulo (o objeto inteiro) é recusado como não objeto',
    async (key) => {
      expect(await errorsOf({ [key]: null })).toEqual([key]);
    },
  );

  it.each(['setup', 'slices', 'items'])(
    '%s que é lista (vazia ou não) é recusado como não objeto (PV-12)',
    async (key) => {
      expect(await errorsOf({ [key]: [] })).toEqual([key]);
      expect(await errorsOf({ [key]: [{}] })).toEqual([key]);
    },
  );

  it('layoutSnapshot nulo é aceito (limpa a coluna, PV-10)', async () => {
    expect(await errorsOf({ layoutSnapshot: null })).toEqual([]);
  });

  describe('setup', () => {
    it('apara o nome e recusa o em branco e o de 121 caracteres', async () => {
      const dto = plainToInstance(SaveFlyerProDocumentDto, {
        ...VALID,
        setup: { name: '  Ofertas Piccin semana 48  ' },
      });
      expect(await validate(dto)).toEqual([]);
      expect(dto.setup.name).toBe('Ofertas Piccin semana 48');
      expect(await errorsOf({ setup: { name: '   ' } })).toEqual(['setup']);
      expect(await errorsOf({ setup: { name: 'x'.repeat(121) } })).toEqual(['setup']);
      expect(await errorsOf({ setup: { name: 'x'.repeat(120) } })).toEqual([]);
    });

    it.each([
      ['pageCount', 0],
      ['pageCount', 5],
      ['pageCount', 2.5],
      ['clientId', 'abc'],
      ['sceneId', 'abc'],
      ['refreshTemplate', 'sim'],
    ])('recusa setup.%s=%p', async (field, value) => {
      expect(await errorsOf({ setup: { [field]: value } })).toEqual(['setup']);
    });

    it('campo desconhecido no setup é recusado', async () => {
      expect(await errorsOf({ setup: { format: '54x40' } })).toEqual(['setup']);
    });
  });
});

describe('nulo dentro de setup e de items (DT-95): 400 de forma, nunca campo ausente', () => {
  const paths = (body: Record<string, unknown>) =>
    nestedErrorsOf(SaveFlyerProDocumentDto, { ...VALID, ...body });

  it.each([
    ['setup.name', { setup: { name: null } }],
    ['setup.clientId', { setup: { clientId: null } }],
    ['setup.sceneId', { setup: { sceneId: null } }],
    ['setup.refreshTemplate', { setup: { refreshTemplate: null } }],
    ['setup.pageCount', { setup: { pageCount: null } }],
    ['items.upsert', { items: { upsert: null } }],
    ['items.delete', { items: { delete: null } }],
    ['items.replaceAll', { items: { replaceAll: null } }],
  ])('%s nulo é recusado, com o erro na propriedade aninhada', async (path, body) => {
    expect(await paths(body)).toEqual([path]);
  });

  it('um campo nulo junto de um válido recusa o corpo todo, e só aponta o nulo', async () => {
    expect(await paths({ setup: { name: 'Ofertas Piccin semana 48', pageCount: null } })).toEqual([
      'setup.pageCount',
    ]);
    expect(await paths({ items: { upsert: [], delete: null } })).toEqual(['items.delete']);
  });

  it('o corpo de um PATCH já aceito (o mesmo mutationId) com items.upsert nulo também é recusado, antes do reenvio', async () => {
    const accepted = {
      mutationId: VALID.mutationId,
      expectedRevision: 37,
      items: { upsert: null },
    };
    expect(await paths(accepted)).toEqual(['items.upsert']);
  });

  it('o campo ausente continua válido, e os ramos que chegam como lista seguem recusados', async () => {
    expect(await paths({ setup: { name: 'Ofertas Piccin semana 48' } })).toEqual([]);
    expect(await paths({ items: { upsert: [] } })).toEqual([]);
    expect(await paths({ items: { upsert: [{ id: VALID.mutationId }] } })).toEqual([]);
    expect(await paths({ setup: [], slices: [{}], items: [] })).toEqual([
      'setup',
      'slices',
      'items',
    ]);
  });

  it('o null dentro de um item de upsert continua valendo como valor (ean, price e importId nulos)', async () => {
    const item = { id: VALID.mutationId, ean: null, price: null, importId: null };
    expect(await paths({ items: { upsert: [item] } })).toEqual([]);
  });
});
