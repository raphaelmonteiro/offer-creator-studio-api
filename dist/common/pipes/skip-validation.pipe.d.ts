import { PipeTransform, ArgumentMetadata } from '@nestjs/common';
export declare class SkipValidationPipe implements PipeTransform {
    transform(value: any, metadata: ArgumentMetadata): any;
}
