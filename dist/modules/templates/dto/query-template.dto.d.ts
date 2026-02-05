import { TemplateType } from './create-template.dto';
export declare class QueryTemplateDto {
    page?: number;
    limit?: number;
    search?: string;
    type?: TemplateType;
    isDefault?: boolean;
}
