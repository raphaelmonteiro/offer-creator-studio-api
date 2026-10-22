import { HttpException } from '@nestjs/common';
import { CommercialsService } from '../commercials.service';
import { defaultPieceDocument, McPieceDocument } from '../domain/mc-piece';
import { McPiece } from '../entities/mc-piece.entity';
import { McFromPieceService } from './mc-from-piece.service';
import { McPiecesService } from './mc-pieces.service';

function readyDocument(mode: 'in_piece' | 'logo_face' = 'in_piece'): McPieceDocument {
  const doc = defaultPieceDocument('4:5');
  const products = doc.blocks[0] as Extract<
    McPieceDocument['blocks'][number],
    { type: 'products' }
  >;
  products.items = [
    {
      id: 'p1',
      catalogId: 'cat-1',
      name: 'Picanha bovina',
      price: '59,90',
      unit: 'kg',
      imageUrl: '/uploads/gallery/p1.png',
      spoken: true,
    },
    {
      id: 'p2',
      catalogId: null,
      name: 'Cerveja lata',
      price: '3,49',
      unit: 'un',
      imageUrl: '/uploads/gallery/p2.png',
      spoken: false,
    },
    {
      id: 'p3',
      catalogId: 'cat-3',
      name: 'Arroz tipo 1',
      price: '24,90',
      imageUrl: '/uploads/gallery/p3.png',
      spoken: true,
    },
  ];
  doc.blocks.push({
    id: 'character',
    type: 'character',
    rect: { x: 0.6, y: 0.62, w: 0.35, h: 0.26 },
    zIndex: 4,
    kitId: 'kit-1',
    mode,
    panel: { shape: 'card', color: '#FAFAFA' },
  });
  return doc;
}

const responseOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HttpException) return { status: err.getStatus(), body: err.getResponse() };
    throw err;
  }
  throw new Error('esperava rejeição');
};

describe('McFromPieceService — ponte peça → projeto (tarefa 5.1)', () => {
  const env = { ...process.env };
  let pieces: { findOwned: jest.Mock; issuesFor: jest.Mock };
  let commercials: { createProject: jest.Mock };
  let service: McFromPieceService;
  const piece = (over: Partial<McPiece> = {}): McPiece =>
    ({
      id: 'piece-1',
      userId: 'u1',
      clientId: 'c1',
      kind: 'piece',
      name: 'Ofertas da semana',
      aspectRatio: '4:5',
      document: readyDocument(),
      revision: 2,
      ...over,
    }) as McPiece;

  beforeEach(() => {
    process.env.MC_FORMATS = 'offer_piece';
    process.env.MC_PIPELINE_V2 = 'all';
    pieces = {
      findOwned: jest.fn().mockResolvedValue(piece()),
      issuesFor: jest.fn().mockResolvedValue([]),
    };
    commercials = {
      createProject: jest.fn((userId: string, dto: unknown, extras: unknown) =>
        Promise.resolve({ id: 'proj-1', userId, dto, extras }),
      ),
    };
    service = new McFromPieceService(
      pieces as unknown as McPiecesService,
      commercials as unknown as CommercialsService,
    );
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it('peça pronta → createProject com offer_piece, ofertas FALADAS na ordem, snapshot e defaults', async () => {
    const result = await service.createFromPiece('u1', { pieceId: 'piece-1' });
    expect(result).toMatchObject({ id: 'proj-1' });
    const [userId, dto, extras] = commercials.createProject.mock.calls[0];
    expect(userId).toBe('u1');
    expect(dto).toMatchObject({
      kitId: 'kit-1',
      title: 'Ofertas da semana',
      aspectRatio: '4:5',
      targetDurationS: 25,
      format: 'offer_piece',
      tier: 'economico',
      captionsEnabled: false,
      musicEnabled: false,
    });
    expect(dto.products).toEqual([
      { name: 'Picanha bovina', price: '59,90', unit: 'kg', imageUrl: '/uploads/gallery/p1.png' },
      { name: 'Arroz tipo 1', price: '24,90', unit: null, imageUrl: '/uploads/gallery/p3.png' },
    ]);
    expect(dto.briefing).toContain('Picanha bovina por R$ 59,90 (kg)');
    expect(dto.briefing.length).toBeGreaterThanOrEqual(10);
    expect(extras).toEqual({ pieceId: 'piece-1', pieceSnapshot: readyDocument(), logoBox: null });
  });

  it('título, tier, canal, legendas e trilha do DTO vencem os defaults', async () => {
    await service.createFromPiece('u1', {
      pieceId: 'piece-1',
      title: 'Feirão',
      tier: 'premium',
      channel: 'whatsapp',
      captionsEnabled: true,
      musicEnabled: true,
    });
    expect(commercials.createProject.mock.calls[0][1]).toMatchObject({
      title: 'Feirão',
      tier: 'premium',
      channel: 'whatsapp',
      captionsEnabled: true,
      musicEnabled: true,
    });
  });

  it('rosto do logo: o rect do personagem vira a caixa do logo confirmada, com a cor do painel', async () => {
    pieces.findOwned.mockResolvedValue(piece({ document: readyDocument('logo_face') }));
    await service.createFromPiece('u1', { pieceId: 'piece-1' });
    expect(commercials.createProject.mock.calls[0][2].logoBox).toEqual({
      x: 0.6,
      y: 0.62,
      w: 0.35,
      h: 0.26,
      logoBoxSource: 'layout',
      logoBoxConfidence: null,
      logoBoxConfirmed: true,
      surroundColor: '#FAFAFA',
    });
  });

  it('peça com issues → 422 PIECE_INVALID com a lista; modelo → 422 PIECE_IS_TEMPLATE; nada é criado', async () => {
    pieces.issuesFor.mockResolvedValue([{ code: 'CHARACTER_MISSING', message: 'x' }]);
    expect(await responseOf(service.createFromPiece('u1', { pieceId: 'piece-1' }))).toEqual({
      status: 422,
      body: expect.objectContaining({
        code: 'PIECE_INVALID',
        issues: [{ code: 'CHARACTER_MISSING', message: 'x' }],
      }),
    });
    pieces.issuesFor.mockResolvedValue([]);
    pieces.findOwned.mockResolvedValue(piece({ kind: 'template' }));
    expect(await responseOf(service.createFromPiece('u1', { pieceId: 'piece-1' }))).toMatchObject({
      status: 422,
      body: { code: 'PIECE_IS_TEMPLATE' },
    });
    expect(commercials.createProject).not.toHaveBeenCalled();
  });

  it('formato fora de MC_FORMATS → 422 FORMAT_NOT_ENABLED antes de ler a peça; sem v2 → PIPELINE_V2_REQUIRED', async () => {
    process.env.MC_FORMATS = 'talking_art';
    expect(await responseOf(service.createFromPiece('u1', { pieceId: 'piece-1' }))).toMatchObject({
      status: 422,
      body: { code: 'FORMAT_NOT_ENABLED' },
    });
    process.env.MC_FORMATS = 'offer_piece';
    process.env.MC_PIPELINE_V2 = 'off';
    expect(await responseOf(service.createFromPiece('u1', { pieceId: 'piece-1' }))).toMatchObject({
      status: 422,
      body: { code: 'PIPELINE_V2_REQUIRED' },
    });
    expect(pieces.findOwned).not.toHaveBeenCalled();
  });
});
