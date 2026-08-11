export interface StorageReference {
  provider: string;
  externalId: string;
  url: string;
}

export interface FileMetadata {
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
}

export interface StorageProvider {
  validateReference(input: string): Promise<StorageReference>;
  getMetadata(reference: StorageReference): Promise<FileMetadata>;
  createAccessUrl?(reference: StorageReference): Promise<string>;
}

const DRIVE_PATTERNS = [
  /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
  /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/,
  /docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/,
];

export function parseGoogleDriveInput(input: string): StorageReference | null {
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed) && !trimmed.includes("/")) {
    return {
      provider: "google_drive",
      externalId: trimmed,
      url: `https://drive.google.com/file/d/${trimmed}/view`,
    };
  }
  for (const pattern of DRIVE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return {
        provider: "google_drive",
        externalId: match[1],
        url: trimmed.startsWith("http") ? trimmed : `https://drive.google.com/file/d/${match[1]}/view`,
      };
    }
  }
  return null;
}

export class GoogleDriveStorageProvider implements StorageProvider {
  async validateReference(input: string): Promise<StorageReference> {
    const ref = parseGoogleDriveInput(input);
    if (!ref) {
      throw new Error("INVALID_DRIVE_REFERENCE");
    }
    return ref;
  }

  async getMetadata(reference: StorageReference): Promise<FileMetadata> {
    return {
      name: reference.externalId,
      mimeType: null,
      sizeBytes: null,
    };
  }
}

export class MockStorageProvider implements StorageProvider {
  async validateReference(input: string): Promise<StorageReference> {
    const ref = parseGoogleDriveInput(input);
    if (ref) return ref;
    return {
      provider: "google_drive",
      externalId: `mock-${input.slice(0, 20)}`,
      url: input.startsWith("http") ? input : `https://drive.google.com/file/d/mock/view`,
    };
  }

  async getMetadata(reference: StorageReference): Promise<FileMetadata> {
    return {
      name: `mock-${reference.externalId}`,
      mimeType: "video/mp4",
      sizeBytes: 1024 * 1024,
    };
  }
}

export function getStorageProvider(enabled: boolean): StorageProvider {
  return enabled ? new GoogleDriveStorageProvider() : new MockStorageProvider();
}
