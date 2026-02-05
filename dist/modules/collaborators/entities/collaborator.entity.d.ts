export declare class Collaborator {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    password: string;
    role: string;
    status: string;
    avatarUrl: string | null;
    createdAt: Date;
    updatedAt: Date;
    hashPassword(): Promise<void>;
    validatePassword(password: string): Promise<boolean>;
}
