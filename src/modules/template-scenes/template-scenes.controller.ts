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
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CreateSceneDto } from './dto/create-scene.dto';
import { GetSceneQueryDto, ListScenesQueryDto } from './dto/list-scenes-query.dto';
import { PatchElementsDto } from './dto/patch-elements.dto';
import { RestoreVersionDto } from './dto/restore-version.dto';
import { sceneNotFound, versionNotFound } from './scene.errors';
import { SceneVersionsService } from './services/scene-versions.service';
import { TemplateScenesService } from './services/template-scenes.service';
import { TemplateSceneEnabledGuard } from './template-scene-enabled.guard';

/** Id que não é UUID também é "cena não encontrada" (sem revelar nada além disso). */
export const SceneIdPipe = new ParseUUIDPipe({ exceptionFactory: () => sceneNotFound() });
export const VersionIdPipe = new ParseUUIDPipe({ exceptionFactory: () => versionNotFound() });

@ApiTags('template-scenes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TemplateSceneEnabledGuard)
@Controller('template-scenes')
export class TemplateScenesController {
  constructor(
    private readonly scenes: TemplateScenesService,
    private readonly versions: SceneVersionsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Cria uma cena num formato de impressão' })
  create(@Body() dto: CreateSceneDto, @CurrentUser() user: { id: string }) {
    return this.scenes.create(dto, user?.id ?? null);
  }

  @Get()
  @ApiOperation({ summary: 'Lista as cenas de todos os usuários (leve, paginada)' })
  list(@Query() query: ListScenesQueryDto) {
    return this.scenes.list(query.page, query.limit);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Abre a cena: versão atual, zonas, mensagens e versões' })
  get(@Param('id', SceneIdPipe) id: string, @Query() query: GetSceneQueryDto) {
    return this.scenes.get(id, query.versionsPage);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Exclui (logicamente) a cena e cancela a versão em curso' })
  async remove(@Param('id', SceneIdPipe) id: string): Promise<void> {
    await this.scenes.remove(id);
  }

  @Post(':id/versions/:versionId/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restaura uma versão antiga criando uma versão nova (filha)' })
  restore(
    @Param('id', SceneIdPipe) id: string,
    @Param('versionId', VersionIdPipe) versionId: string,
    @Body() dto: RestoreVersionDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.versions.restore(id, versionId, user?.id ?? null, dto?.expectedRevision);
  }

  @Patch(':id/elements')
  @ApiOperation({ summary: 'Edita as camadas à mão (versão manual aberta), sem chamar o modelo' })
  patchElements(
    @Param('id', SceneIdPipe) id: string,
    @Body() dto: PatchElementsDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.versions.patchElements(id, dto, user?.id ?? null);
  }
}
