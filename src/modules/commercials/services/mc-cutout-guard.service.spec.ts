import { DataSource } from 'typeorm';
import { McPieceDocument } from '../domain/mc-piece';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McCutoutGuardService } from './mc-cutout-guard.service';
import { McKitBodyTileService } from './mc-kit-body-tile.service';

const KEY_OK = {
  ruleVersion: 1,
  chosen: '#00B140',
  safe: true,
  candidates: [{ color: '#00B140', near40: 0, near60: 0 }],
};
const KEY_BAD = {
  ruleVersion: 1,
  chosen: null,
  safe: false,
  candidates: [
    { color: '#00B140', near40: 0.2, near60: 0.4 },
    { color: '#0047BB', near40: 0.2, near60: 0.4 },
  ],
};

function doc(over: Record<string, unknown> = {}, mode = 'in_piece'): McPieceDocument {
  return {
    schemaVersion: 1,
    aspectRatio: '4:5',
    background: { mode: 'solid', color: '#1E50C8' },
    blocks: [
      {
        id: 'character',
        type: 'character',
        rect: { x: 0.05, y: 0.6, w: 0.4, h: 0.3 },
        zIndex: 3,
        kitId: 'kit-1',
        mode,
        panel: { shape: 'none', color: '#FFFFFF' },
        ...over,
      },
    ],
  } as unknown as McPieceDocument;
}

describe('McCutoutGuardService — checagens do recorte antes de gastar', () => {
  const original = process.env.MC_CHARACTER_CUTOUT;
  let kit: Record<string, unknown> | null;
  let bodyTile: { ensure: jest.Mock };
  let guard: McCutoutGuardService;

  beforeEach(() => {
    process.env.MC_CHARACTER_CUTOUT = 'true';
    kit = { id: 'kit-1', userId: 'u1' };
    bodyTile = { ensure: jest.fn().mockResolvedValue({ metadata: { cutoutKey: KEY_OK } }) };
    const dataSource = {
      getRepository: jest.fn((entity: unknown) =>
        entity === McCharacterKit ? { findOne: jest.fn(() => Promise.resolve(kit)) } : {},
      ),
    } as unknown as DataSource;
    guard = new McCutoutGuardService(dataSource, bodyTile as unknown as McKitBodyTileService);
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MC_CHARACTER_CUTOUT;
    else process.env.MC_CHARACTER_CUTOUT = original;
  });

  it('valor fora da lista → 400 PIECE_CHARACTER_FIELD_INVALID com bloco, campo e permitidos', async () => {
    await expect(
      guard.assertPiece('u1', doc({ panel: { shape: 'transparente', color: '#FFFFFF' } })),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        code: 'PIECE_CHARACTER_FIELD_INVALID',
        details: {
          blockId: 'character',
          field: 'panel.shape',
          allowed: ['none', 'card', 'circle'],
        },
      },
    });
    await expect(guard.assertPiece('u1', doc({ framing: 'inteiro' }))).rejects.toMatchObject({
      status: 400,
      response: { details: { field: 'framing' } },
    });
    expect(bodyTile.ensure).not.toHaveBeenCalled();
  });

  it('flag desligada: sem fundo e corpo → 422 CHARACTER_CUTOUT_DISABLED; Card e busto explícito passam', async () => {
    delete process.env.MC_CHARACTER_CUTOUT;
    await expect(guard.assertPiece('u1', doc())).rejects.toMatchObject({
      status: 422,
      response: { code: 'CHARACTER_CUTOUT_DISABLED' },
    });
    await expect(
      guard.assertPiece(
        'u1',
        doc({ panel: { shape: 'card', color: '#FFFFFF' }, framing: 'corpo' }),
      ),
    ).rejects.toMatchObject({ response: { code: 'CHARACTER_CUTOUT_DISABLED' } });
    await expect(
      guard.assertPiece(
        'u1',
        doc({ panel: { shape: 'card', color: '#FFFFFF' }, framing: 'busto' }),
      ),
    ).resolves.toEqual({ cutout: false, framing: 'busto', keyColor: null });
    expect(bodyTile.ensure).not.toHaveBeenCalled();
  });

  it('rosto do logo com sem fundo → 422 CHARACTER_CUTOUT_LOGO_FACE, sem calcular tile', async () => {
    await expect(guard.assertPiece('u1', doc({}, 'logo_face'))).rejects.toMatchObject({
      status: 422,
      response: { code: 'CHARACTER_CUTOUT_LOGO_FACE' },
    });
    expect(bodyTile.ensure).not.toHaveBeenCalled();
  });

  it('chave insegura → 422 CHARACTER_CUTOUT_KEY_UNSAFE com candidatas e a ação use_flat_panel', async () => {
    bodyTile.ensure.mockResolvedValue({ metadata: { cutoutKey: KEY_BAD } });
    await expect(guard.assertPiece('u1', doc())).rejects.toMatchObject({
      status: 422,
      response: {
        code: 'CHARACTER_CUTOUT_KEY_UNSAFE',
        details: {
          kitId: 'kit-1',
          actions: ['use_flat_panel'],
          candidates: [
            { color: '#00B140', nearFraction40: 0.2, nearFraction60: 0.4 },
            { color: '#0047BB', nearFraction40: 0.2, nearFraction60: 0.4 },
          ],
        },
      },
    });
  });

  it('caminho feliz: sem fundo devolve a chave; corpo em Card não exige chave segura', async () => {
    await expect(guard.assertPiece('u1', doc())).resolves.toEqual({
      cutout: true,
      framing: 'corpo',
      keyColor: '#00B140',
    });
    bodyTile.ensure.mockResolvedValue({ metadata: { cutoutKey: KEY_BAD } });
    await expect(
      guard.assertPiece(
        'u1',
        doc({ panel: { shape: 'card', color: '#FFFFFF' }, framing: 'corpo' }),
      ),
    ).resolves.toEqual({ cutout: false, framing: 'corpo', keyColor: null });
  });

  it('kit inexistente ou de outro dono: sem 422 de recorte (a issue CHARACTER_KIT_UNKNOWN segue)', async () => {
    kit = null;
    await expect(guard.assertPiece('u1', doc())).resolves.toEqual({
      cutout: true,
      framing: 'corpo',
      keyColor: null,
    });
    expect(bodyTile.ensure).not.toHaveBeenCalled();
  });

  it('erro do tile de corpo (422) propaga sem gravar nada', async () => {
    bodyTile.ensure.mockRejectedValue(
      Object.assign(new Error('x'), {
        status: 422,
        response: { code: 'BODY_TILE_BORDER_NOT_UNIFORM' },
      }),
    );
    await expect(guard.assertPiece('u1', doc())).rejects.toMatchObject({
      response: { code: 'BODY_TILE_BORDER_NOT_UNIFORM' },
    });
  });
});
