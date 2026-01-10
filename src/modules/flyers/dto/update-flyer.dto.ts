import { PartialType } from '@nestjs/swagger';
import { CreateFlyerDto } from './create-flyer.dto';

export class UpdateFlyerDto extends PartialType(CreateFlyerDto) {}
