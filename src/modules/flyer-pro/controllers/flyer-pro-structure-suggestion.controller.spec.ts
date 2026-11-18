import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import type { StructureSuggestionDto } from '../dto/structure-suggestion.dto';
import type { FlyerProStructureSuggestionService } from '../services/flyer-pro-structure-suggestion.service';
import { DocumentIdPipe } from './flyer-pro-documents.controller';
import { FlyerProStructureSuggestionController } from './flyer-pro-structure-suggestion.controller';

function setup() {
  const suggestions = { suggest: jest.fn() };
  const controller = new FlyerProStructureSuggestionController(
    suggestions as unknown as FlyerProStructureSuggestionService,
  );
  return { controller, suggestions };
}

describe('FlyerProStructureSuggestionController', () => {
  it('fica no prefixo flyer-pro/documents (PV-1) e exige o guard JWT', () => {
    expect(Reflect.getMetadata(PATH_METADATA, FlyerProStructureSuggestionController)).toBe(
      'flyer-pro/documents',
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, FlyerProStructureSuggestionController)).toEqual([
      JwtAuthGuard,
    ]);
  });

  it('POST :id/structure-suggestion responde 200 e passa o id pelo DocumentIdPipe', () => {
    const handler = FlyerProStructureSuggestionController.prototype.suggest;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/structure-suggestion');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      FlyerProStructureSuggestionController,
      'suggest',
    ) as Record<string, { data: string; pipes: unknown[] }>;
    const idArg = Object.values(args).find((arg) => arg.data === 'id');
    expect(idArg?.pipes).toEqual([DocumentIdPipe]);
  });

  it('entrega o id e o corpo ao serviço e devolve a proposta como veio', async () => {
    const { controller, suggestions } = setup();
    const view = { suggestionId: 's1' };
    suggestions.suggest.mockResolvedValue(view);
    const dto = { stateDigest: 'x' } as StructureSuggestionDto;

    await expect(controller.suggest('d1', dto)).resolves.toBe(view);

    expect(suggestions.suggest).toHaveBeenCalledWith('d1', dto);
  });
});
