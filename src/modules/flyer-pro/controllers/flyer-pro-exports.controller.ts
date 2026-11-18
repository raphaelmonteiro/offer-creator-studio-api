import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../../common/decorators/user.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CreateFlyerProExportDto } from '../dto/create-flyer-pro-export.dto';
import { ListFlyerProExportsQueryDto } from '../dto/list-exports-query.dto';
import { FlyerProExportsService } from '../services/flyer-pro-exports.service';
import { DocumentIdPipe } from './flyer-pro-documents.controller';

/** A entrada do histórico, a mesma do registro sem `replayed` (`a2-api.html#n8` e `#n9`). */
const EXPORT_ENTRY_EXAMPLE = {
  id: '5b0e2c1a-8d3f-4a4e-9c11-2f6a7d9e0b13',
  documentId: '2c1d7e9b-4f6a-4b1e-9a3d-7e5f0c8b6a21',
  format: 'pdf',
  options: {
    preset: 'pdf-450-all',
    dpi: 450,
    unit: 'sheet',
    sheets: [1, 2],
    color: 'rgb',
    jpegQuality: 0.95,
    widthPx: 9567,
    heightPx: 7087,
    bleed: false,
  },
  documentRevision: 41,
  engineVersion: 1,
  renderDigest: 'f3a91c07d2be4410',
  fileName: 'ofertas-piccin-semana-47-todas-450dpi-20261114-1502.pdf',
  fileSize: 31457280,
  preflight: { problems: 1, warnings: 3, infos: 1 },
  fileState: 'not_stored',
  hasFile: false,
  createdByUserId: 'b02d5a10-3c4e-4f7a-9d21-6e8f0a1b2c3d',
  createdByName: 'Ana',
  createdAt: '2026-11-14T18:02:11.000Z',
};

const REGISTER_EXAMPLE = { success: true, data: { ...EXPORT_ENTRY_EXAMPLE, replayed: false } };

const HISTORY_EXAMPLE = {
  success: true,
  data: [EXPORT_ENTRY_EXAMPLE],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
};

/**
 * N8 e N9, no mesmo prefixo das rotas do encarte, em controller próprio (o de documentos já está no limite de linhas).
 * Nenhum arquivo é recebido nem guardado (PU-50): o registro é só JSON.
 */
@ApiTags('Flyer Pro')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('flyer-pro/documents/:id/exports')
export class FlyerProExportsController {
  constructor(private readonly exports: FlyerProExportsService) {}

  @Post()
  @ApiOperation({
    summary:
      'Registra uma exportação já baixada (só o histórico, sem arquivo); repetir o mesmo id no mesmo encarte devolve a linha gravada; não muda o encarte',
  })
  @ApiResponse({
    status: 201,
    description: 'Exportação registrada (replayed: false)',
    schema: { example: REGISTER_EXAMPLE },
  })
  @ApiResponse({ status: 200, description: 'Repetição do mesmo id (replayed: true)' })
  @ApiResponse({
    status: 400,
    description: 'BAD_REQUEST: forma, campo desconhecido (inclusive exportedAt) ou corpo {}',
  })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED: sem token' })
  @ApiResponse({
    status: 404,
    description: 'FLYER_PRO_NOT_FOUND: inexistente, excluído ou id inválido',
  })
  @ApiResponse({
    status: 409,
    description: 'FLYER_PRO_EXPORT_ID_CONFLICT (details.exportId): o id é de outro encarte',
  })
  @ApiResponse({
    status: 422,
    description:
      'FLYER_PRO_EXPORT_INVALID (issues: PRESET_MISMATCH, FILE_NAME_EXTENSION, REVISION_AHEAD)',
  })
  async register(
    @Param('id', DocumentIdPipe) id: string,
    @Body() dto: CreateFlyerProExportDto,
    @CurrentUser() user: { id: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const { view, created } = await this.exports.register(id, dto, user.id);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return view;
  }

  @Get()
  @ApiOperation({
    summary:
      'Histórico das exportações do encarte, da mais recente para a mais antiga, paginado; não grava',
  })
  @ApiResponse({
    status: 200,
    description:
      'Exportações com createdByName (nulo se o usuário não existe mais), com a paginação',
    schema: { example: HISTORY_EXAMPLE },
  })
  @ApiResponse({
    status: 400,
    description: 'BAD_REQUEST: consulta fora da forma (inclusive search)',
  })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED: sem token' })
  @ApiResponse({
    status: 404,
    description: 'FLYER_PRO_NOT_FOUND: inexistente, excluído ou id inválido',
  })
  list(@Param('id', DocumentIdPipe) id: string, @Query() query: ListFlyerProExportsQueryDto) {
    return this.exports.list(id, query);
  }
}
