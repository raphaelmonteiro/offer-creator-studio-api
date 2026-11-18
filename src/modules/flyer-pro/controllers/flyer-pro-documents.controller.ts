import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
import { QueryFlyerProDocumentsDto } from '../dto/query-flyer-pro-documents.dto';
import { FlyerProDocumentsService } from '../services/flyer-pro-documents.service';

/** Id que não é UUID também é "encarte não encontrado" (sem revelar nada além disso). */
export const DocumentIdPipe = new ParseUUIDPipe({ exceptionFactory: () => flyerProNotFound() });

@ApiTags('Flyer Pro')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('flyer-pro/documents')
export class FlyerProDocumentsController {
  constructor(private readonly documents: FlyerProDocumentsService) {}

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
