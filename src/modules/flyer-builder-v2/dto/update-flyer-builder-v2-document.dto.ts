import { PartialType } from '@nestjs/swagger';
import { CreateFlyerBuilderV2DocumentDto } from './create-flyer-builder-v2-document.dto';

export class UpdateFlyerBuilderV2DocumentDto extends PartialType(CreateFlyerBuilderV2DocumentDto) {}

