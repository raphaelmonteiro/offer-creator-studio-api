import { ArgumentMetadata } from '@nestjs/common';
import { ValidationPipe, ValidationPipeOptions } from '@nestjs/common';
export declare class SmartValidationPipe extends ValidationPipe {
    constructor(options?: ValidationPipeOptions);
    transform(value: any, metadata: ArgumentMetadata): any;
}
