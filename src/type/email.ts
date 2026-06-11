
export interface EmailTemplate {
    to: string;
    subject: string;
    text?: string;
    template?: string;
    context: {
        inviteUrl?: string;
        companyName?: string;
        name?: string;
  
    };
}
