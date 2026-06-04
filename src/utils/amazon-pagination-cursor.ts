// amazon-api-client.ts or helper
export function encodeCursor(cursors: Record<number, string | null>): string | null {
  const hasAny = Object.values(cursors).some(Boolean);
  if (!hasAny) return null;
  return Buffer.from(JSON.stringify(cursors)).toString('base64url');
}

export function decodeCursor(cursor: string): Record<number, string | null> {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
  } catch {
    return {};
  }
}