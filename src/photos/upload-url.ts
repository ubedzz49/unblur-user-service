import crypto from "node:crypto";

export interface PhotoUploadUrl {
  uploadUrl: string;
  publicUrl: string;
}

export interface PhotoUploadUrlProvider {
  createUploadUrl(userId: string, contentType: string): Promise<PhotoUploadUrl>;
}

export const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"];

export function extensionFor(contentType: string): string {
  switch (contentType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      throw new Error(`unsupported content type: ${contentType}`);
  }
}

export function buildPhotoKey(userId: string, contentType: string): string {
  return `profile-photos/${userId}/${crypto.randomUUID()}.${extensionFor(contentType)}`;
}

// test-only -- avoids CI needing real S3 access
export class FakePhotoUploadUrlProvider implements PhotoUploadUrlProvider {
  async createUploadUrl(userId: string, contentType: string): Promise<PhotoUploadUrl> {
    const key = buildPhotoKey(userId, contentType);
    return {
      uploadUrl: `https://fake-upload.test/${key}`,
      publicUrl: `https://fake-public.test/${key}`,
    };
  }
}
