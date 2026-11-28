import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PhotoDownloadResponseDto } from '../dto/flyer-pro-photo-download-response.dto';
import { PhotoDownloadDto } from '../dto/flyer-pro-photo-download.dto';
import { PhotoSearchResponseDto } from '../dto/flyer-pro-photo-search-response.dto';
import { PhotoSearchDto } from '../dto/flyer-pro-photo-search.dto';
import { FlyerProPhotoDownloadService } from '../services/flyer-pro-photo-download.service';
import { FlyerProPhotoSearchService } from '../services/flyer-pro-photo-search.service';
import { DocumentIdPipe } from './flyer-pro-documents.controller';
import { ItemIdPipe } from './flyer-pro-item-id.pipe';

/**
 * A busca de fotos do item no Google (B1) e o download da foto escolhida para a Galeria (B2), no mesmo prefixo das rotas do
 * encarte e em controller próprio (A-2). Qualquer usuário logado pode usar (PU-01); nada é gravado no encarte.
 */
@ApiTags('Flyer Pro')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('flyer-pro/documents')
export class FlyerProPhotoSearchController {
  constructor(
    private readonly photoSearch: FlyerProPhotoSearchService,
    private readonly photoDownload: FlyerProPhotoDownloadService,
  ) {}

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

  @Post(':id/items/:itemId/photo-search/download')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Baixa para a Galeria a foto de um resultado da busca guardada do item (só pelo resultId; nenhum endereço no corpo); não conta no teto de buscas e não grava o encarte',
  })
  @ApiResponse({ status: 200, type: PhotoDownloadResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'BAD_REQUEST: forma, campo desconhecido (imageUrl inclusive), resultId vazio ou acima de 64, corpo {} ou itemId que não é UUID',
  })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED: sem token' })
  @ApiResponse({
    status: 404,
    description:
      'FLYER_PRO_NOT_FOUND (encarte) ou FLYER_PRO_PHOTO_RESULT_NOT_FOUND (resultId de outro item, vencido, de antes do reinício ou inventado)',
  })
  @ApiResponse({
    status: 422,
    description:
      'FLYER_PRO_PHOTO_DOWNLOAD_REFUSED (details.reason: SCHEME, PRIVATE_ADDRESS, TOO_MANY_REDIRECTS, NOT_AN_IMAGE ou TOO_LARGE)',
  })
  @ApiResponse({
    status: 502,
    description:
      'FLYER_PRO_PHOTO_DOWNLOAD_FAILED (details.reason: ORIGIN_STATUS, NETWORK, TIMEOUT ou RESOLVE_FAILED)',
  })
  @ApiResponse({
    status: 503,
    description:
      'FLYER_PRO_PHOTO_SEARCH_UNAVAILABLE (details.reason: NO_API_KEY): o resultado é um link do Google e falta a chave para resolvê-lo',
  })
  download(
    @Param('id', DocumentIdPipe) id: string,
    @Param('itemId', ItemIdPipe) itemId: string,
    @Body() dto: PhotoDownloadDto,
  ) {
    return this.photoDownload.download(id, itemId, dto);
  }
}
