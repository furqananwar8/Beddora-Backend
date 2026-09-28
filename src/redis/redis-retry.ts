/**
 * Reconnect forever with capped backoff (1s, 2s, … max 10s).
 * Returning null (the old "give up after 3 tries") left the app running with
 * dead Redis clients — no jobs processed, no tokens readable — until a manual
 * restart. Logs are throttled so a long outage doesn't flood them.
 */
export function redisRetryStrategy(label: string) {
  return (times: number): number => {
    const delay = Math.min(times * 1000, 10_000);
    if (times <= 5 || times % 30 === 0) {
      console.log(`[REDIS:${label}] Reconnect attempt ${times} in ${delay}ms`);
    }
    return delay;
  };
}
