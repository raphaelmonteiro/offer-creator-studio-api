import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Client } from '../../clients/entities/client.entity';
import { Font } from '../../fonts/entities/font.entity';
import { defaultPieceDocument, MC_PIECE_MAX_BYTES, McPieceDocument } from '../domain/mc-piece';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McPiece } from '../entities/mc-piece.entity';
import { McProject } from '../entities/mc-project.entity';
import { McPiecesService } from './mc-pieces.service';

const CLIENT = {
  id: 'c1',
  name: 'Mercado Bom Preço',
  logoUrl: '/uploads/logos/bom-preco.png',
  address: 'Av. Marechal, 639',
  phoneFixed: '(11) 3333-0000',
  phoneMobile: '(11) 99432-7127',
};

function fullDocument(): McPieceDocument {
  const doc = defaultPieceDocument('9:16');
  const products = doc.blocks[0] as Extract<
    McPieceDocument['blocks'][number],
    { type: 'products' }
  >;
  products.items = [1, 2].map((i) => ({
    id: `p${i}`,
    catalogId: `cat-${i}`,
    name: `Produto ${i} especial`,
    price: `${i},99`,
    imageUrl: `/uploads/gallery/p${i}.png`,
    spoken: true,
  }));
  doc.blocks.push({
    id: 'character',
    type: 'character',
    rect: { x: 0.6, y: 0.62, w: 0.35, h: 0.26 },
    zIndex: 4,
    kitId: 'kit-1',
    mode: 'in_piece',
    panel: { shape: 'card', color: '#FFFFFF' },
  });
  return doc;
}

describe('McPiecesService — CRUD, autosave por revisão, modelos (grupo 4)', () => {
  let pieces: Map<string, McPiece>;
  let repos: Map<unknown, Record<string, jest.Mock>>;
  let service: McPiecesService;

  function row(over: Partial<McPiece>): McPiece {
    return {
      id: 'piece-1',
      userId: 'u1',
      clientId: 'c1',
      kind: 'piece',
      name: 'Ofertas',
      aspectRatio: '9:16',
      document: fullDocument(),
      revision: 3,
      createdAt: new Date('2026-10-22T00:00:00Z'),
      updatedAt: new Date('2026-10-22T00:00:00Z'),
      ...over,
    } as McPiece;
  }

  beforeEach(() => {
    pieces = new Map();
    let seq = 0;
    const pieceRepo = {
      findOneBy: jest.fn(({ id }: { id: string }) => Promise.resolve(pieces.get(id) ?? null)),
      findOneByOrFail: jest.fn(({ id }: { id: string }) => Promise.resolve(pieces.get(id))),
      find: jest.fn(() => Promise.resolve([...pieces.values()])),
      save: jest.fn((data: Partial<McPiece>) => {
        seq += 1;
        const saved = row({
          id: `piece-${seq + 10}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        });
        pieces.set(saved.id, saved);
        return Promise.resolve(saved);
      }),
      update: jest.fn((where: { id: string; revision: number }, patch: Partial<McPiece>) => {
        const current = pieces.get(where.id);
        if (!current || current.revision !== where.revision)
          return Promise.resolve({ affected: 0 });
        pieces.set(where.id, { ...current, ...patch } as McPiece);
        return Promise.resolve({ affected: 1 });
      }),
      delete: jest.fn(({ id }: { id: string }) => {
        pieces.delete(id);
        return Promise.resolve({ affected: 1 });
      }),
    };
    repos = new Map<unknown, Record<string, jest.Mock>>([
      [McPiece, pieceRepo],
      [
        Client,
        {
          findOneBy: jest.fn(({ id }: { id: string }) =>
            Promise.resolve(id === 'c1' ? CLIENT : null),
          ),
        },
      ],
      [
        Font,
        { find: jest.fn().mockResolvedValue([{ family: 'Montserrat' }, { family: 'Montserrat' }]) },
      ],
      [
        McCharacterKit,
        {
          findOne: jest.fn(({ where }: { where: { id: string; userId: string } }) =>
            Promise.resolve(
              where.id === 'kit-1' && where.userId === 'u1'
                ? { id: 'kit-1', identityMode: 'generated' }
                : null,
            ),
          ),
        },
      ],
      [McProject, { count: jest.fn().mockResolvedValue(0) }],
    ]);
    const dataSource = { getRepository: jest.fn((entity: unknown) => repos.get(entity)) };
    service = new McPiecesService(dataSource as unknown as DataSource);
  });

  it('create: peça em branco do cliente com logo e rodapé do cadastro, nome padrão e issues do que falta', async () => {
    const view = await service.create('u1', { clientId: 'c1', aspectRatio: '4:5' });
    expect(view).toMatchObject({
      userId: 'u1',
      clientId: 'c1',
      kind: 'piece',
      aspectRatio: '4:5',
      revision: 0,
    });
    expect(view.name).toBe('Ofertas de Mercado Bom Preço');
    expect(view.document.aspectRatio).toBe('4:5');
    expect(view.document.blocks.find((b) => b.type === 'logo')).toMatchObject({
      imageUrl: CLIENT.logoUrl,
    });
    expect(view.document.blocks.find((b) => b.type === 'footer')).toMatchObject({
      address: CLIENT.address,
      phone: CLIENT.phoneMobile,
    });
    expect(view.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['CHARACTER_MISSING', 'PRODUCTS_TOO_FEW']),
    );
  });

  it('create: cliente inexistente → 404; modelo que não é modelo → 422; modelo de outro dono → 403', async () => {
    await expect(
      service.create('u1', { clientId: 'zz', aspectRatio: '9:16' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    pieces.set('piece-1', row({}));
    await expect(
      service.create('u1', { clientId: 'c1', aspectRatio: '9:16', templateId: 'piece-1' }),
    ).rejects.toMatchObject({
      response: { code: 'PIECE_NOT_TEMPLATE' },
    });
    pieces.set('tpl-x', row({ id: 'tpl-x', userId: 'u2', kind: 'template' }));
    await expect(
      service.create('u1', { clientId: 'c1', aspectRatio: '9:16', templateId: 'tpl-x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('create a partir de modelo: visual do modelo, formato pedido, logo e rodapé do cliente', async () => {
    const template = row({ id: 'tpl-1', kind: 'template', clientId: null, aspectRatio: '9:16' });
    template.document = { ...template.document, background: { mode: 'solid', color: '#123456' } };
    pieces.set('tpl-1', template);
    const view = await service.create('u1', {
      clientId: 'c1',
      aspectRatio: '4:5',
      templateId: 'tpl-1',
      name: 'Semana 42',
    });
    expect(view.name).toBe('Semana 42');
    expect(view.document.background).toEqual({ mode: 'solid', color: '#123456' });
    expect(view.document.aspectRatio).toBe('4:5');
    expect(view.aspectRatio).toBe('4:5');
    expect(view.document.blocks.find((b) => b.type === 'logo')).toMatchObject({
      imageUrl: CLIENT.logoUrl,
    });
  });

  it('findOne: issues com contexto do banco (fontes da conta, kit do personagem)', async () => {
    pieces.set('piece-1', row({}));
    expect((await service.findOne('u1', 'piece-1')).issues).toEqual([]);

    const unknownKit = row({ id: 'piece-2' });
    (unknownKit.document.blocks[2] as { kitId: string }).kitId = 'kit-9';
    unknownKit.document.blocks.push({
      id: 'title',
      type: 'text',
      rect: { x: 0.1, y: 0.05, w: 0.8, h: 0.1 },
      zIndex: 3,
      text: 'Chamada',
      fontFamily: 'Comic',
      fontSize: 0.05,
      color: '#000000',
      align: 'left',
      weight: 'bold',
    });
    pieces.set('piece-2', unknownKit);
    const view = await service.findOne('u1', 'piece-2');
    expect(view.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'CHARACTER_KIT_UNKNOWN', blockId: 'character' }),
        expect.objectContaining({ code: 'FONT_UNKNOWN', blockId: 'title' }),
      ]),
    );
    await expect(service.findOne('u2', 'piece-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.findOne('u1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update: grava com a revisão esperada e devolve revision + 1; revisão errada → 409 com a atual', async () => {
    pieces.set('piece-1', row({ revision: 3 }));
    const document = fullDocument();
    document.background = { mode: 'solid', color: '#000000' };
    const view = await service.update('u1', 'piece-1', {
      document,
      expectedRevision: 3,
      name: 'Nova',
    });
    expect(view).toMatchObject({ revision: 4, name: 'Nova', issues: [] });
    expect(view.document.background).toEqual({ mode: 'solid', color: '#000000' });

    await expect(
      service.update('u1', 'piece-1', { document, expectedRevision: 3 }),
    ).rejects.toMatchObject({
      response: { code: 'REVISION_CONFLICT', revision: 4 },
    });
    await expect(
      service.update('u1', 'piece-1', { document, expectedRevision: 3 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('update: regras de negócio abertas NÃO bloqueiam (voltam em issues); estrutura inválida → 422 PIECE_INVALID; tamanho → 422', async () => {
    pieces.set('piece-1', row({ revision: 0 }));
    const incomplete = defaultPieceDocument('9:16'); // sem personagem e sem produtos
    const view = await service.update('u1', 'piece-1', {
      document: incomplete,
      expectedRevision: 0,
    });
    expect(view.revision).toBe(1);
    expect(view.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['CHARACTER_MISSING', 'PRODUCTS_TOO_FEW']),
    );

    const broken = fullDocument();
    broken.blocks.push({ id: 'products', type: 'sticker' } as never);
    await expect(
      service.update('u1', 'piece-1', { document: broken, expectedRevision: 1 }),
    ).rejects.toMatchObject({
      response: {
        code: 'PIECE_INVALID',
        issues: expect.arrayContaining([expect.objectContaining({ code: 'BLOCK_DUPLICATE_ID' })]),
      },
    });

    const huge = fullDocument();
    huge.blocks.push({
      id: 'big',
      type: 'text',
      rect: { x: 0, y: 0, w: 0.5, h: 0.1 },
      zIndex: 9,
      text: 'x'.repeat(MC_PIECE_MAX_BYTES),
      fontSize: 0.05,
      color: '#000000',
      align: 'left',
      weight: 'regular',
    });
    await expect(
      service.update('u1', 'piece-1', { document: huge, expectedRevision: 1 }),
    ).rejects.toMatchObject({
      response: { code: 'PIECE_TOO_LARGE' },
    });
    expect(pieces.get('piece-1')?.revision).toBe(1);
  });

  it('saveAsTemplate: modelo da conta sem produtos, logo e dados do cliente', async () => {
    const source = row({});
    source.document = { ...source.document, blocks: [...source.document.blocks] };
    source.document.blocks.unshift({
      id: 'logo',
      type: 'logo',
      rect: { x: 0.06, y: 0.04, w: 0.28, h: 0.12 },
      zIndex: 5,
      imageUrl: CLIENT.logoUrl,
    });
    pieces.set('piece-1', source);
    const template = await service.saveAsTemplate('u1', 'piece-1', { name: 'Semanal' });
    expect(template).toMatchObject({
      kind: 'template',
      clientId: null,
      name: 'Semanal',
      revision: 0,
      aspectRatio: '9:16',
    });
    expect(template.document.blocks.find((b) => b.type === 'logo')).toMatchObject({
      imageUrl: null,
    });
    expect(template.document.blocks.find((b) => b.type === 'products')).toMatchObject({
      items: [],
    });
    expect(template.document.blocks.find((b) => b.type === 'character')).toMatchObject({
      kitId: 'kit-1',
    });
  });

  it('remove: peça com projeto em andamento → 422 PIECE_IN_USE; livre → apaga', async () => {
    pieces.set('piece-1', row({}));
    repos.get(McProject)!.count.mockResolvedValueOnce(1);
    await expect(service.remove('u1', 'piece-1')).rejects.toMatchObject({
      response: { code: 'PIECE_IN_USE' },
    });
    expect(pieces.has('piece-1')).toBe(true);
    await expect(service.remove('u1', 'piece-1')).resolves.toEqual({ deleted: true });
    expect(pieces.has('piece-1')).toBe(false);
  });

  it('findAll: filtra por dono, kind e cliente, sem issues', async () => {
    pieces.set('piece-1', row({}));
    const rows = await service.findAll('u1', { kind: 'piece', clientId: 'c1' });
    expect(rows).toHaveLength(1);
    expect((rows[0] as { issues?: unknown }).issues).toBeUndefined();
    expect(repos.get(McPiece)!.find).toHaveBeenCalledWith({
      where: { userId: 'u1', kind: 'piece', clientId: 'c1' },
      order: { updatedAt: 'DESC' },
    });
  });
});
