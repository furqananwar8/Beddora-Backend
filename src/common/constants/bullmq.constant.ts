export const AMAZON_TOKEN_REFRESH = 'amazon-token-refresh';
export const AMAZON_TOKEN_TTL_MS = 60 * 60 * 1000;      // 1 hour (production)
export const REFRESH_BUFFER_MS = 5 * 60 * 1000;         // 5 minutes
export const REFRESH_JOB_DELAY_MS = AMAZON_TOKEN_TTL_MS - REFRESH_BUFFER_MS; // 55 

export const TEST_REFRESH_DELAY_MS = 10 * 1000; // 10 seconds