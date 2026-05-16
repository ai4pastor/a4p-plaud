type ElectronSafeStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

function getSafeStorage(): ElectronSafeStorage | null {
  try {
    const w = window as unknown as { require?: (m: string) => unknown };
    const req = w.require ?? (typeof require === "function" ? require : null);
    if (!req) return null;
    const electron = req("electron") as Record<string, unknown>;
    const remote = electron?.remote as Record<string, unknown> | undefined;
    return (
      (remote?.safeStorage as ElectronSafeStorage | undefined) ??
      (electron?.safeStorage as ElectronSafeStorage | undefined) ??
      null
    );
  } catch {
    return null;
  }
}

export function isEncryptionAvailable(): boolean {
  const s = getSafeStorage();
  try {
    return s?.isEncryptionAvailable?.() === true;
  } catch {
    return false;
  }
}

export function encryptToBase64(plain: string): string {
  const s = getSafeStorage();
  if (!s || !s.isEncryptionAvailable()) {
    throw new Error("SAFE_STORAGE_UNAVAILABLE");
  }
  const buf = s.encryptString(plain);
  return buf.toString("base64");
}

export function decryptFromBase64(b64: string): string {
  const s = getSafeStorage();
  if (!s || !s.isEncryptionAvailable()) {
    throw new Error("SAFE_STORAGE_UNAVAILABLE");
  }
  const buf = Buffer.from(b64, "base64");
  return s.decryptString(buf);
}
