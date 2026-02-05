export declare enum TemplateType {
    HEADER = "header",
    FOOTER = "footer",
    FULL = "full"
}
export declare class CreateTemplateDto {
    name: string;
    type: TemplateType;
    configuration: any;
    isDefault?: boolean;
}
