import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PhotoSearchResponseDto } from '../dto/flyer-pro-photo-search-response.dto';
import { PhotoSearchDto } from '../dto/flyer-pro-photo-search.dto';
import { FlyerProPhotoSearchService } from '../services/flyer-pro-photo-search.service';
import { DocumentIdPipe } from './flyer-pro-documents.controller';
import { ItemIdPipe } from './flyer-pro-item-id.pipe';

/**
 * A busca de fotos do item no Google (B1) e, na task seguinte, o download da foto escolhida (B2), no mesmo prefixo das
 * rotas do encarte e em controller próprio (A-2). Qualquer usuário logado pode buscar (PU-01); nada é gravado no encarte.
 */
@ApiTags('Flyer Pro')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('flyer-pro/documents')
export class FlyerProPhotoSearchController {
  constructor(private readonly photoSearch: FlyerProPhotoSearchService) {}

  @Post(':id/items/:itemId/photo-search')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Busca fotos do item no Google Imagens pela Serper (país, idioma e quantidade fixos no servidor); a resposta fica guardada 24 h por item, termo e página; não grava o encarte',
  })
  @ApiResponse({ status: 200, type: PhotoSearchResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'BAD_REQUEST: forma, campo desconhecido, termo vazio ou acima de 120, page fora de 1 a 10 (null inclusive), corpo {} ou itemId que não é UUID',
  })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED: sem token' })
  @ApiResponse({
    status: 404,
    description: 'FLYER_PRO_NOT_FOUND: inexistente, excluído ou id inválido',
  })
  @ApiResponse({
    status: 429,
    description:
      'FLYER_PRO_PHOTO_SEARCH_BUSY (details.reason: HOURLY_LIMIT, com retryAfterSeconds): teto de buscas pagas do encarte em 60 minutos',
  })
  @ApiResponse({
    status: 503,
    description:
      'FLYER_PRO_PHOTO_SEARCH_UNAVAILABLE (details.reason: NO_API_KEY) ou FLYER_PRO_PHOTO_SEARCH_FAILED (details.reason: TIMEOUT, AUTH, QUOTA ou PROVIDER_ERROR)',
  })
  search(
    @Param('id', DocumentIdPipe) id: string,
    @Param('itemId', ItemIdPipe) itemId: string,
    @Body() dto: PhotoSearchDto,
  ) {
    return this.photoSearch.search(id, itemId, dto);
  }
}
