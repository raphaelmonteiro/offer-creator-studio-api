import { BadRequestException } from '@nestjs/common';
import { SmartValidationPipe } from '../../../common/pipes/smart-validation.pipe';
import { AdminGcDto } from './admin-gc.dto';
import { CreateSceneDto } from './create-scene.dto';
import {
  GetSceneQueryDto,
  ListMessagesQueryDto,
  ListScenesQueryDto,
} from './list-scenes-query.dto';
import { PatchElementsDto } from './patch-elements.dto';
import { SendMessageDto } from './send-message.dto';

/** O mesmo pipe global do `main.ts`: campo desconhecido é 400. */
const pipe = new SmartValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  skipMissingProperties: false,
});
const body = (value: unknown, metatype: new () => object) =>
  pipe.transform(value, { type: 'body', metatype });
const query = (value: unknown, metatype: new () => object) =>
  pipe.transform(value, { type: 'query', metatype });

const element = {
  id: 'el-1',
  kind: 'text',
  name: 'Título',
  x: 0.5,
  y: 0.1,
  w: 0.4,
  aspect: 3,
  rotation: 0,
  z: 1,
  text: 'Páscoa',
};

describe('DTOs da cena', () => {
  describe('CreateSceneDto', () => {
    it('aceita nome e formato e apara os espaços', async () => {
      const dto = (await body(
        { name: '  Páscoa ', formatId: 'folheto-27x54' },
        CreateSceneDto,
      )) as CreateSceneDto;
      expect(dto.name).toBe('Páscoa');
    });

    it.each([
      { name: '', formatId: 'folheto-27x54' },
      { name: '   ', formatId: 'x' },
      { name: 'a' },
    ])('recusa %j', async (payload) => {
      await expect(body(payload, CreateSceneDto)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('recusa campo desconhecido', async () => {
      await expect(
        body({ name: 'a', formatId: 'folheto-27x54', widthPx: 10 }, CreateSceneDto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('SendMessageDto', () => {
    it('aceita mensagem com revisão', async () => {
      const dto = (await body(
        { content: 'campo verde', expectedRevision: 0 },
        SendMessageDto,
      )) as SendMessageDto;
      expect(dto.expectedRevision).toBe(0);
    });

    it.each([
      { content: 'x' },
      { content: '', expectedRevision: 0 },
      { content: 'x', expectedRevision: -1 },
      { content: 'x', expectedRevision: 1.5 },
      { content: 'x'.repeat(2001), expectedRevision: 0 },
    ])('recusa %j', async (payload) => {
      await expect(body(payload, SendMessageDto)).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['confirmGlobal', true],
      ['replyToMessageId', '11111111-1111-4111-8111-111111111111'],
    ])('campos antigos recusados: %s dá 400 (R20, saiu do e2e)', async (field, value) => {
      await expect(
        body({ content: 'campo verde', expectedRevision: 0, [field]: value }, SendMessageDto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each(['imageUrl', 'target', 'maskUploadId', 'url'])(
      'recusa o campo %s (a API recebe dados, nunca URL)',
      async (field) => {
        await expect(
          body({ content: 'x', expectedRevision: 0, [field]: 'http://x/a.png' }, SendMessageDto),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    describe('campos de alvo (estágio 4)', () => {
      const send = (extra: Record<string, unknown>) =>
        body(
          { content: 'x', expectedRevision: 0, ...extra },
          SendMessageDto,
        ) as Promise<SendMessageDto>;
      const lasso = (n: number) => ({
        kind: 'lasso',
        points: Array.from({ length: n }, (_v, i) => ({ x: (i % 100) / 100, y: 0.5 })),
      });

      it('aceita região, forma, zona e elemento', async () => {
        expect((await send({ region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } })).region?.w).toBe(0.2);
        expect((await send({ mask: lasso(10) })).mask?.kind).toBe('lasso');
        expect((await send({ zone: 'body' })).zone).toBe('body');
        expect((await send({ targetElementId: 'logo-1' })).targetElementId).toBe('logo-1');
      });

      it('recusa campo desconhecido, ponto com carga extra e traços vazios no mask (R2)', async () => {
        const tri = [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0.5, y: 1 },
        ];
        await expect(
          send({ mask: { kind: 'lasso', points: tri, imageUrl: 'http://x' } }),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          send({
            mask: {
              kind: 'lasso',
              points: [{ ...tri[0], blob: 'x'.repeat(1_000_000) }, tri[1], tri[2]],
            },
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          send({
            mask: {
              kind: 'brush',
              radius: 0.02,
              strokes: [[{ x: 0, y: 0 }], ...Array.from({ length: 100_000 }, () => [])],
            },
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('recusa repositionGenerated (D-13): campo desconhecido', async () => {
        await expect(send({ repositionGenerated: true })).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });

      it('aceita 2000 pontos e recusa 2001', async () => {
        await expect(send({ mask: lasso(2000) })).resolves.toBeDefined();
        await expect(send({ mask: lasso(2001) })).rejects.toBeInstanceOf(BadRequestException);
      });

      it.each([
        [{ region: { x: -0.1, y: 0, w: 0.2, h: 0.2 } }],
        [{ region: { x: 0, y: 0, w: 0, h: 0.2 } }],
        [{ region: { x: 0, y: 0, w: 1.5, h: 0.2 } }],
        [{ region: 'a' }],
        [{ mask: { kind: 'lasso', points: [{ x: 0, y: 0 }] } }],
        [{ mask: { kind: 'brush', radius: 0.02, strokes: [[{ x: 3, y: 0 }]] } }],
        [{ mask: 'x' }],
        [{ zone: 'meio' }],
        [{ targetElementId: 'x'.repeat(65) }],
        [{ confirmGlobal: true }],
        [{ confirmGlobal: 'sim' }],
        [{ replyToMessageId: '11111111-1111-4111-8111-111111111111' }],
        [{ replyToMessageId: 'abc' }],
      ])('recusa %j', async (extra) => {
        await expect(send(extra)).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    describe('GET .../messages', () => {
      const messages = (payload: Record<string, unknown>) => query(payload, ListMessagesQueryDto);

      it('aceita sem nada, com cursor UUID e com limite de 1 a 50 (texto da query vira número)', async () => {
        await expect(messages({})).resolves.toBeDefined();
        const ok = (await messages({
          before: '11111111-1111-4111-8111-111111111111',
          limit: '20',
        })) as ListMessagesQueryDto;
        expect(ok.limit).toBe(20);
      });

      it.each([
        { before: 'abc' },
        { before: 123 },
        { limit: '0' },
        { limit: '51' },
        { limit: 'muitos' },
        { limit: '1.5' },
        { desconhecido: '1' },
      ])('Cursor inválido: recusa %j com 400', async (payload) => {
        await expect(messages(payload)).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    it('recusa anexo sem assetId válido', async () => {
      await expect(
        body(
          { content: 'x', expectedRevision: 0, attachments: [{ assetId: 'abc' }] },
          SendMessageDto,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('PatchElementsDto', () => {
    it('aceita elementos válidos', async () => {
      const dto = (await body(
        { expectedRevision: 2, elements: [element] },
        PatchElementsDto,
      )) as PatchElementsDto;
      expect(dto.elements).toHaveLength(1);
    });

    it.each(['src', 'imageUrl', 'url'])('recusa o campo %s dentro do elemento', async (field) => {
      await expect(
        body(
          { expectedRevision: 0, elements: [{ ...element, [field]: 'https://x/a.png' }] },
          PatchElementsDto,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('recusa tipo de elemento desconhecido e assetId que não é uuid', async () => {
      await expect(
        body({ expectedRevision: 0, elements: [{ ...element, kind: 'video' }] }, PatchElementsDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        body({ expectedRevision: 0, elements: [{ ...element, assetId: 'abc' }] }, PatchElementsDto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('recusa mais de 100 elementos', async () => {
      const many = Array.from({ length: 101 }, (_, i) => ({ ...element, id: `e${i}` }));
      await expect(
        body({ expectedRevision: 0, elements: many }, PatchElementsDto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('consultas e admin', () => {
    it('limita a lista a 50 itens por página', async () => {
      await expect(query({ limit: '51' }, ListScenesQueryDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      const ok = (await query(
        { page: '2', limit: '50' },
        ListScenesQueryDto,
      )) as ListScenesQueryDto;
      expect(ok).toMatchObject({ page: 2, limit: 50 });
    });

    it('recusa página zero das versões', async () => {
      await expect(query({ versionsPage: '0' }, GetSceneQueryDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('dryRun do admin é booleano', async () => {
      await expect(body({ dryRun: 'sim' }, AdminGcDto)).rejects.toBeInstanceOf(BadRequestException);
      expect(await body({ dryRun: false }, AdminGcDto)).toMatchObject({ dryRun: false });
    });
  });
});
