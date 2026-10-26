import {
  McPieceCharacterBlock,
  McPieceDocument,
  pieceCharacterVideoFields,
  pieceChangeScope,
  validatePieceDocument,
} from './mc-piece';
import {
  characterFieldViolations,
  pieceRecordingReasons,
  resolveCharacterFraming,
} from './mc-piece-character';
import { scriptContentHash, talkTileChanged } from './mc-script-v2';
import { McScript } from './mc-types';

const block = (over: Partial<McPieceCharacterBlock> = {}): McPieceCharacterBlock => ({
  id: 'character',
  type: 'character',
  rect: { x: 0.05, y: 0.62, w: 0.4, h: 0.3 },
  zIndex: 3,
  kitId: 'kit-1',
  mode: 'in_piece',
  panel: { shape: 'card', color: '#FFE082' },
  ...over,
});

function doc(character: McPieceCharacterBlock): McPieceDocument {
  return {
    schemaVersion: 1,
    aspectRatio: '4:5',
    background: { mode: 'solid', color: '#1E50C8' },
    blocks: [character],
  } as McPieceDocument;
}

describe('enquadramento resolvido (video-mascote-transparente, D8)', () => {
  it('ausente: corpo no sem fundo, busto no Card e no Círculo; explícito vence', () => {
    expect(resolveCharacterFraming(block())).toBe('busto');
    expect(resolveCharacterFraming(block({ panel: { shape: 'none', color: '#FFFFFF' } }))).toBe(
      'corpo',
    );
    expect(resolveCharacterFraming(block({ framing: 'corpo' }))).toBe('corpo');
    expect(
      resolveCharacterFraming(block({ framing: 'busto', panel: { shape: 'none', color: '#FFF' } })),
    ).toBe('busto');
  });

  it('valor fora da lista de panel.shape e framing vira violação com os permitidos', () => {
    const bad = block({
      framing: 'inteiro' as never,
      panel: { shape: 'transparente' as never, color: '#FFFFFF' },
    });
    expect(characterFieldViolations(doc(bad))).toEqual([
      { blockId: 'character', field: 'panel.shape', allowed: ['none', 'card', 'circle'] },
      { blockId: 'character', field: 'framing', allowed: ['busto', 'corpo'] },
    ]);
    expect(characterFieldViolations(doc(block({ framing: 'corpo' })))).toEqual([]);
  });
});

describe('issues do recorte em validatePieceDocument', () => {
  const codes = (b: McPieceCharacterBlock, ctx = {}) =>
    validatePieceDocument(doc(b), ctx).map((i) => i.code);

  it('flag desligada marca sem fundo e corpo; busto explícito e Card passam', () => {
    const none = block({ panel: { shape: 'none', color: '#FFFFFF' } });
    expect(codes(none, { cutoutEnabled: false })).toContain('CHARACTER_CUTOUT_DISABLED');
    expect(codes(block({ framing: 'corpo' }), { cutoutEnabled: false })).toContain(
      'CHARACTER_CUTOUT_DISABLED',
    );
    expect(codes(block({ framing: 'busto' }), { cutoutEnabled: false })).not.toContain(
      'CHARACTER_CUTOUT_DISABLED',
    );
    expect(codes(block(), { cutoutEnabled: false })).not.toContain('CHARACTER_CUTOUT_DISABLED');
    expect(codes(none, { cutoutEnabled: true })).not.toContain('CHARACTER_CUTOUT_DISABLED');
    expect(codes(none)).not.toContain('CHARACTER_CUTOUT_DISABLED'); // ctx ausente = não checa
  });

  it('rosto do logo com sem fundo ou corpo → CHARACTER_CUTOUT_LOGO_FACE', () => {
    expect(
      codes(block({ mode: 'logo_face', panel: { shape: 'none', color: '#FFFFFF' } })),
    ).toContain('CHARACTER_CUTOUT_LOGO_FACE');
    expect(codes(block({ mode: 'logo_face', framing: 'corpo' }))).toContain(
      'CHARACTER_CUTOUT_LOGO_FACE',
    );
    expect(codes(block({ mode: 'logo_face' }))).not.toContain('CHARACTER_CUTOUT_LOGO_FACE');
  });
});

describe('pieceCharacterVideoFields e hashes de quem não usa o modo', () => {
  it('Card e Círculo seguem sem os campos novos; sem fundo e corpo os levam ao roteiro', () => {
    const card = pieceCharacterVideoFields(doc(block()));
    expect(card).toEqual({
      window: { x: 0.05, y: 0.62, w: 0.4, h: 0.3 },
      logoFace: false,
      talkBackgroundColor: '#FFE082',
    });
    expect(
      pieceCharacterVideoFields(doc(block({ panel: { shape: 'none', color: '#FFE082' } }))),
    ).toMatchObject({ cutout: true, framing: 'corpo' });
    expect(pieceCharacterVideoFields(doc(block({ framing: 'corpo' })))).toEqual(
      expect.objectContaining({ framing: 'corpo' }),
    );
    expect(pieceCharacterVideoFields(doc(block({ framing: 'corpo' })))).not.toHaveProperty(
      'cutout',
    );
  });

  it('scriptContentHash: campo novo só entra quando definido (roteiro existente não muda)', () => {
    const base = { version: 1, schemaVersion: 2, scenes: [], products: [] } as unknown as McScript;
    expect(scriptContentHash({ ...base, cutout: undefined })).toBe(scriptContentHash(base));
    expect(scriptContentHash({ ...base, cutout: true, framing: 'corpo' })).not.toBe(
      scriptContentHash(base),
    );
    expect(scriptContentHash({ ...base, cutout: true, cutoutKeyColor: '#0047BB' })).not.toBe(
      scriptContentHash({ ...base, cutout: true, cutoutKeyColor: '#00B140' }),
    );
  });

  it('talkTileChanged: sem fundo, enquadramento ou chave', () => {
    const base = { version: 1, scenes: [] } as unknown as McScript;
    expect(talkTileChanged(base, { ...base })).toBe(false);
    expect(talkTileChanged(base, { ...base, cutout: true, framing: 'corpo' })).toBe(true);
    expect(talkTileChanged(base, { ...base, framing: 'corpo' })).toBe(true);
  });
});

describe('pieceChangeScope e recordingReasons da troca de modo', () => {
  const none = block({ panel: { shape: 'none', color: '#FFE082' } });

  it('reenvio igual é none; trocar só o modo é visual (a regravação é decidida fora do escopo)', () => {
    expect(pieceChangeScope(doc(none), doc(none))).toBe('none');
    expect(pieceChangeScope(doc(block()), doc(none))).toBe('visual');
  });

  it('motivos: sem fundo entra/sai, enquadramento, cor com painel visível, modo', () => {
    expect(pieceRecordingReasons(block(), none)).toEqual(['character_cutout', 'character_framing']);
    expect(pieceRecordingReasons(none, none)).toEqual([]);
    expect(
      pieceRecordingReasons(block(), block({ panel: { shape: 'card', color: '#000000' } })),
    ).toEqual(['panel_color']);
    // cor mudou mas o painel não é desenhado: não regrava
    expect(
      pieceRecordingReasons(none, block({ panel: { shape: 'none', color: '#000000' } })),
    ).toEqual([]);
    // card ↔ circle é só visual
    expect(
      pieceRecordingReasons(block(), block({ panel: { shape: 'circle', color: '#FFE082' } })),
    ).toEqual([]);
    expect(pieceRecordingReasons(block(), block({ mode: 'logo_face' }))).toEqual([
      'character_mode',
    ]);
  });
});
