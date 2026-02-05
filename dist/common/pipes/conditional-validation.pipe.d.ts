import { PipeTransform, ArgumentMetadata } from '@nestjs/common';
import { ValidationPipeOptions } from '@nestjs/common';
export declare class ConditionalValidationPipe implements PipeTransform {
    private validationPipe;
    constructor(options?: ValidationPipeOptions);
    transform(value: any, metadata: ArgumentMetadata): any;
}
