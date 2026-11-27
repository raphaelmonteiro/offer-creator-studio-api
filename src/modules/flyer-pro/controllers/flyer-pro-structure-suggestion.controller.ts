import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { StructureSuggestionResponseDto } from '../dto/structure-suggestion-response.dto';
import { StructureSuggestionDto } from '../dto/structure-suggestion.dto';
import { FlyerProStructureSuggestionService } from '../services/flyer-pro-structure-suggestion.service';
import { DocumentIdPipe } from './flyer-pro-documents.controller';

/**
 * N19, no mesmo prefixo das rotas do encarte, em controller próprio (PV-1: o de documentos já passa de 4 dependências e
 * está perto do limite de linhas).
 */
@ApiTags('Flyer Pro')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('flyer-pro/documents')
export class FlyerProStructureSuggestionController {
  constructor(private readonly suggestions: FlyerProStructureSuggestionService) {}

  @Post(':id/structure-suggestion')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Sugere a estrutura do encarte (ordem das seções, página de algumas, ordem dos produtos de cada seção, destaques, sugeridos do motor a desfazer e a campanha lida no nome) a partir do retrato da Estrutura; não grava nada e cada pedido gera outra sugestão',
  })
  @ApiResponse({ status: 200, type: StructureSuggestionResponseDto })
  @ApiResponse({
    status: 400,
    description: 'BAD_REQUEST: forma, campo desconhecido, corpo {} ou mais de 500 ids de item',
  })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED: sem token' })
  @ApiResponse({
    status: 404,
    description: 'FLYER_PRO_NOT_FOUND: inexistente, excluído ou id inválido',
  })
  @ApiResponse({
    status: 422,
    description:
      'FLYER_PRO_STRUCTURE_STATE_INVALID (issues), FLYER_PRO_STRUCTURE_AI_DISABLED (details.reason: FLAG, NO_API_KEY ou MODEL_PRICE_UNKNOWN), FLYER_PRO_PAGE_COUNT_INVALID ou FLYER_PRO_NO_ITEMS',
  })
  @ApiResponse({
    status: 429,
    description:
      'FLYER_PRO_STRUCTURE_AI_BUSY (details.reason: IN_FLIGHT ou HOURLY_LIMIT, com retryAfterSeconds)',
  })
  @ApiResponse({
    status: 503,
    description:
      'FLYER_PRO_STRUCTURE_AI_FAILED (details.reason: PROVIDER_ERROR, TIMEOUT ou INVALID_OUTPUT, com suggestionId)',
  })
  suggest(@Param('id', DocumentIdPipe) id: string, @Body() dto: StructureSuggestionDto) {
    return this.suggestions.suggest(id, dto);
  }
}
