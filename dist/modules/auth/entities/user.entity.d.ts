export declare class User {
    id: string;
    email: string;
    password: string;
    name: string;
    emailVerified: boolean;
    role: string;
    phone: string | null;
    cpfCnpj: string | null;
    establishment: {
        tradeName?: string;
        companyName?: string;
        address?: string;
        city?: string;
        state?: string;
        zipCode?: string;
    } | null;
    avatarUrl: string | null;
    emailVerificationToken: string | null;
    emailVerificationExpires: Date | null;
    passwordResetToken: string | null;
    passwordResetExpires: Date | null;
    createdAt: Date;
    updatedAt: Date;
    hashPassword(): Promise<void>;
    hashPasswordIfChanged(): Promise<void>;
    validatePassword(password: string): Promise<boolean>;
}
