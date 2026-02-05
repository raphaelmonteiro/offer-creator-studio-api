declare class EstablishmentDto {
    tradeName?: string;
    companyName?: string;
    address?: string;
    city?: string;
    state?: string;
    zipCode?: string;
}
export declare class UpdateProfileDto {
    name?: string;
    phone?: string;
    cpfCnpj?: string;
    avatarUrl?: string | null;
    establishment?: EstablishmentDto;
}
export {};
