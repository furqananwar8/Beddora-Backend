
export interface EmailTemplate {
    to: string;
    subject: string;
    text?: string;
    template?: string;
    context: {
        inviteUrl?: string;
        companyName?: string;
        name?: string;
        campaignId?: string;
         action?: string;
          jobType?: string;
          scheduleId?: string;
          executeAt?: string;
          errorMessage?: string,
          attemptsMade?: number,
          timestamp?: string,
  
    };
}
