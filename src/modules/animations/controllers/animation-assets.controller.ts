import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, ILike, IsNull } from 'typeorm';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/user.decorator';
import { AnimationAsset } from '../entities/animation-asset.entity';

class UpdateAssetDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsIn(['approved', 'archived', 'ready'])
  status?: string;
}

@ApiTags('animations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('animations/assets')
export class AnimationAssetsController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  findAll(
    @CurrentUser() user: { id: string },
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.dataSource.getRepository(AnimationAsset).find({
      where: {
        userId: user.id,
        deletedAt: IsNull(),
        ...(kind && { kind: kind as AnimationAsset['kind'] }),
        ...(status && { status: status as AnimationAsset['status'] }),
        ...(search && { name: ILike(`%${search}%`) }),
      },
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  @Get(':id')
  async findOne(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.getOwned(user.id, id);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssetDto,
  ) {
    const asset = await this.getOwned(user.id, id);
    Object.assign(asset, dto);
    return this.dataSource.getRepository(AnimationAsset).save(asset);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    await this.getOwned(user.id, id);
    await this.dataSource.getRepository(AnimationAsset).softDelete({ id });
    return { deleted: true };
  }

  private async getOwned(userId: string, id: string): Promise<AnimationAsset> {
    const asset = await this.dataSource
      .getRepository(AnimationAsset)
      .findOne({ where: { id, deletedAt: IsNull() } });
    if (!asset) throw new NotFoundException('Asset não encontrado');
    if (asset.userId !== userId) throw new ForbiddenException();
    return asset;
  }
}
