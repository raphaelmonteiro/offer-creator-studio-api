import { FLYER_PRO_LIMITS } from './flyer-pro.limits';
import { HttpException } from '@nestjs/common';
import {
  assertSaveBody,
  firstOversizedPart,
  isConferenceBody,
  missingSaveFields,
} from './flyer-pro-save-rules';

const BASE = { mutationId: 'm', expectedRevision: 0, schemaVersion: 1, engineVersion: 1 };

/** Um objeto cujo JSON tem exatamente `bytes` bytes. */
const objectOf = (bytes: number) => ({ a: 'x'.repeat(bytes - '{"a":""}'.length) });

describe('missingSaveFields', () => {
  it('corpo {} lista os quatro, na ordem do contrato', () => {
    expect(missingSaveFields({})).toEqual([
      'mutationId',
      'expectedRevision',
      'schemaVersion',
      'engineVersion',
    ]);
  });

  it('lista só o que falta; expectedRevision 0 não falta', () => {
    expect(missingSaveFields({ ...BASE, expectedRevision: undefined })).toEqual([
      'expectedRevision',
    ]);
    expect(missingSaveFields({ ...BASE, schemaVersion: null })).toEqual(['schemaVersion']);
    expect(missingSaveFields(BASE)).toEqual([]);
  });
});

describe('firstOversizedPart', () => {
  it('uma fatia de 300 KB: o nome e o tamanho medido', () => {
    const assembly = objectOf(300 * 1024);
    expect(firstOversizedPart({ slices: { assembly } })).toEqual({
      slice: 'assembly',
      bytes: 300 * 1024,
      max: 262_144,
    });
  });

  it('exatamente 262 144 bytes passa; um byte a mais recusa', () => {
    expect(firstOversizedPart({ slices: { structure: objectOf(262_144) } })).toBeNull();
    expect(firstOversizedPart({ slices: { structure: objectOf(262_145) } })?.slice).toBe(
      'structure',
    );
  });

  it('layoutSnapshot de 130 KB recusa com o teto de 131 072', () => {
    expect(firstOversizedPart({ layoutSnapshot: objectOf(130 * 1024) })).toMatchObject({
      slice: 'layoutSnapshot',
      max: 131_072,
    });
  });

  it('o corpo acima de 2 MB recusa com slice "body" quando nenhuma parte estoura sozinha', () => {
    const piece = objectOf(250 * 1024);
    const body = {
      slices: { frame: piece, structure: piece, card: piece, assembly: piece, exportPrefs: piece },
      items: Array.from({ length: 500 }, () => ({ imported: objectOf(2048) })),
    };
    expect(firstOversizedPart(body)).toMatchObject({
      slice: 'body',
      max: FLYER_PRO_LIMITS.patchMaxBytes,
    });
  });

  it('a ordem é frame, structure, card, assembly, exportPrefs, layoutSnapshot e corpo', () => {
    const big = objectOf(300 * 1024);
    expect(
      firstOversizedPart({ slices: { card: big, frame: big }, layoutSnapshot: big })?.slice,
    ).toBe('frame');
    expect(firstOversizedPart({ slices: { exportPrefs: big }, layoutSnapshot: big })?.slice).toBe(
      'exportPrefs',
    );
    expect(firstOversizedPart({ layoutSnapshot: big })?.slice).toBe('layoutSnapshot');
  });

  it('o acento conta dois bytes: 131 072 caracteres "é" passam de 128 KB no layoutSnapshot', () => {
    expect(firstOversizedPart({ layoutSnapshot: { a: 'é'.repeat(70_000) } })?.slice).toBe(
      'layoutSnapshot',
    );
  });

  it('sem fatias e sem layoutSnapshot não há o que recusar', () => {
    expect(firstOversizedPart({})).toBeNull();
    expect(firstOversizedPart({ slices: {}, layoutSnapshot: null })).toBeNull();
  });
});

describe('isConferenceBody', () => {
  it('corpo só com os obrigatórios, resultados e retrato é regravação de conferência', () => {
    expect(isConferenceBody({})).toBe(true);
    expect(isConferenceBody({ setup: null, slices: undefined })).toBe(true);
  });

  it('setup, slices ou items presentes, mesmo vazios, fazem um PATCH normal', () => {
    expect(isConferenceBody({ setup: {} })).toBe(false);
    expect(isConferenceBody({ slices: {} })).toBe(false);
    expect(isConferenceBody({ items: {} })).toBe(false);
  });
});

describe('assertSaveBody', () => {
  const responseOf = (body: Record<string, unknown>) => {
    try {
      assertSaveBody(body);
    } catch (error) {
      return {
        status: (error as HttpException).getStatus(),
        ...((error as HttpException).getResponse() as object),
      };
    }
    return null;
  };

  it('corpo {} é 400 BAD_REQUEST com a lista dos que faltam', () => {
    expect(responseOf({})).toEqual({
      status: 400,
      code: 'BAD_REQUEST',
      message:
        'Campos obrigatórios ausentes: mutationId, expectedRevision, schemaVersion, engineVersion.',
    });
  });

  it('os obrigatórios vêm antes dos tamanhos', () => {
    const response = responseOf({ slices: { card: objectOf(300 * 1024) } });
    expect(response).toMatchObject({ status: 400, code: 'BAD_REQUEST' });
  });

  it('fatia grande demais é 422 FLYER_PRO_SLICE_TOO_LARGE com slice, bytes e max', () => {
    expect(responseOf({ ...BASE, slices: { assembly: objectOf(300 * 1024) } })).toMatchObject({
      status: 422,
      code: 'FLYER_PRO_SLICE_TOO_LARGE',
      details: { slice: 'assembly', bytes: 300 * 1024, max: 262_144 },
    });
  });

  it('ids repetidos em items.upsert são 400 BAD_REQUEST, antes de qualquer banco', () => {
    const upsert = [{ id: 'a' }, { id: 'b' }, { id: 'a' }];

    expect(responseOf({ ...BASE, items: { upsert } })).toMatchObject({
      status: 400,
      code: 'BAD_REQUEST',
      message: 'Ids repetidos em items.upsert: a.',
    });
    expect(responseOf({ ...BASE, items: { upsert: [{ id: 'a' }, { id: 'b' }] } })).toBeNull();
  });

  it('corpo válido não lança', () => {
    expect(responseOf({ ...BASE, slices: { structure: objectOf(262_144) } })).toBeNull();
  });
});
