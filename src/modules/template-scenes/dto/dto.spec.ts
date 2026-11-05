import { BadRequestException } from '@nestjs/common';
import { SmartValidationPipe } from '../../../common/pipes/smart-validation.pipe';
import { AdminGcDto } from './admin-gc.dto';
import { CreateSceneDto } from './create-scene.dto';
import { GetSceneQueryDto, ListScenesQueryDto } from './list-scenes-query.dto';
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

    it.each(['imageUrl', 'region', 'mask', 'targetElementId', 'target'])(
      'recusa o campo %s (URL e alvo não existem neste estágio)',
      async (field) => {
        await expect(
          body({ content: 'x', expectedRevision: 0, [field]: 'http://x/a.png' }, SendMessageDto),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

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
