import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../../common/decorators/user.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { flyerProNotFound } from '../domain/flyer-pro.errors';
import { CreateFlyerProDocumentDto } from '../dto/create-flyer-pro-document.dto';
import { ListFlyerProItemsQueryDto } from '../dto/list-items-query.dto';
import { QueryFlyerProDocumentsDto } from '../dto/query-flyer-pro-documents.dto';
import { SaveFlyerProDocumentDto } from '../dto/save-flyer-pro-document.dto';
import { UpdateFlyerProCursorDto } from '../dto/update-flyer-pro-cursor.dto';
import { FlyerProCursorService } from '../services/flyer-pro-cursor.service';
import { FlyerProDocumentsService } from '../services/flyer-pro-documents.service';
import { FlyerProItemsService } from '../services/flyer-pro-items.service';
import { FlyerProSaveService } from '../services/flyer-pro-save.service';

/** Id que não é UUID também é "encarte não encontrado" (sem revelar nada além disso). */
export const DocumentIdPipe = new ParseUUIDPipe({ exceptionFactory: () => flyerProNotFound() });

@ApiTags('Flyer Pro')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('flyer-pro/documents')
export class FlyerProDocumentsController {
  constructor(
    private readonly documents: FlyerProDocumentsService,
    private readonly saves: FlyerProSaveService,
    private readonly cursors: FlyerProCursorService,
    private readonly items: FlyerProItemsService,
  ) {}

  @Post()
  @ApiOperation({
    summary:
      'Cria o encarte ao sair do Setup; repetir a mesma creationKey devolve o encarte já criado',
  })
  @ApiResponse({ status: 201, description: 'Encarte criado (replayed: false)' })
  @ApiResponse({ status: 200, description: 'Repetição da creationKey (replayed: true)' })
  @ApiResponse({ status: 400, description: 'BAD_REQUEST: corpo fora da forma' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED: sem token' })
  @ApiResponse({
    status: 404,
    description:
      'CLIENT_NOT_FOUND, FLYER_PRO_TEMPLATE_NOT_FOUND ou FLYER_PRO_NOT_FOUND (chave de encarte excluído)',
  })
  @ApiResponse({
    status: 422,
    description: 'FLYER_PRO_TEMPLATE_UNSUPPORTED ou FLYER_PRO_TEMPLATE_INCOMPLETE',
  })
  async create(
    @Body() dto: CreateFlyerProDocumentDto,
    @CurrentUser() user: { id: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const { document, created } = await this.documents.create(dto, user.id);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return document;
  }

  @Get()
  @ApiOperation({
    summary: 'Lista leve e paginada dos encartes não excluídos de todos os usuários',
  })
  @ApiResponse({ status: 200, description: 'Entradas sem fatias nem itens, com a paginação' })
  @ApiResponse({ status: 400, description: 'BAD_REQUEST: consulta fora da forma' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED: sem token' })
  list(@Query() query: QueryFlyerProDocumentsDto) {
    return this.documents.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Abre o encarte com tudo o que a tela precisa para hidratar; não grava',
  })
  @ApiResponse({
    status: 200,
    description: 'Encarte com fatias, itens, cursor e estado do template',
  })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED: sem token' })
  @ApiResponse({
    status: 404,
    description: 'FLYER_PRO_NOT_FOUND: inexistente, excluído ou id inválido',
  })
  open(@Param('id', DocumentIdPipe) id: string) {
    return this.documents.open(id);
  }

  @Get(':id/items')
  @ApiOperation({
    summary:
      'Lê os itens do encarte, todos ou só os gravados depois de updatedAfter, com o cursor em microssegundos; não grava',
  })
  @ApiResponse({ status: 200, description: '{ items, cursor }' })
  @ApiResponse({ status: 400, description: 'BAD_REQUEST: updatedAfter que não é ISO 8601' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED: sem token' })
  @ApiResponse({
    status: 404,
    description: 'FLYER_PRO_NOT_FOUND: inexistente, excluído ou id inválido',
  })
  listItems(@Param('id', DocumentIdPipe) id: string, @Query() query: ListFlyerProItemsQueryDto) {
    return this.items.list(id, query.updatedAfter);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Salva alterações (Setup, fatias, itens) com revisão; repetir o mesmo mutationId devolve a gravação já aceita',
  })
  @ApiResponse({
    status: 200,
    description:
      'Gravação aceita, reenvio (replayed: true) ou regravação de conferência (applied: true ou false)',
  })
  @ApiResponse({ status: 400, description: 'BAD_REQUEST: corpo fora da forma ou sem obrigatórios' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED: sem token' })
  @ApiResponse({
    status: 404,
    description:
      'FLYER_PRO_NOT_FOUND, CLIENT_NOT_FOUND ou FLYER_PRO_TEMPLATE_NOT_FOUND (cena do setup)',
  })
  @ApiResponse({
    status: 409,
    description: 'REVISION_CONFLICT, FLYER_PRO_APP_OUTDATED ou FLYER_PRO_ITEM_ID_CONFLICT',
  })
  @ApiResponse({
    status: 422,
    description:
      'FLYER_PRO_SLICE_TOO_LARGE, FLYER_PRO_ITEM_INVALID (issues), FLYER_PRO_ITEM_LIMIT, FLYER_PRO_FOLD_LOCKED, FLYER_PRO_PAGE_COUNT_INVALID, FLYER_PRO_TEMPLATE_UNSUPPORTED ou FLYER_PRO_TEMPLATE_INCOMPLETE',
  })
  save(
    @Param('id', DocumentIdPipe) id: string,
    @Body() dto: SaveFlyerProDocumentDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.saves.save(user.id, id, dto);
  }

  @Put(':id/cursor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Grava a etapa atual e o estado de tela, sem revisão e sem 409; chegar à Montagem congela as páginas',
  })
  @ApiResponse({ status: 200, description: '{ step, pagesFrozen }' })
  @ApiResponse({ status: 400, description: 'BAD_REQUEST: step ausente ou fora da lista' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED: sem token' })
  @ApiResponse({
    status: 404,
    description: 'FLYER_PRO_NOT_FOUND: inexistente, excluído ou id inválido',
  })
  @ApiResponse({ status: 422, description: 'FLYER_PRO_UI_TOO_LARGE: ui acima de 16 KB' })
  setCursor(@Param('id', DocumentIdPipe) id: string, @Body() dto: UpdateFlyerProCursorDto) {
    return this.cursors.set(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exclui o encarte (exclusão lógica)' })
  @ApiResponse({ status: 200, description: '{ deleted: true }' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED: sem token' })
  @ApiResponse({
    status: 404,
    description: 'FLYER_PRO_NOT_FOUND: inexistente, já excluído ou id inválido',
  })
  remove(@Param('id', DocumentIdPipe) id: string) {
    return this.documents.remove(id);
  }
}
