import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { buildPhotoKey, PhotoUploadUrl, PhotoUploadUrlProvider } from "./upload-url.js";

const UPLOAD_URL_EXPIRY_SECONDS = 5 * 60;

export class S3PhotoUploadUrlProvider implements PhotoUploadUrlProvider {
  private client: S3Client;
  private bucket: string;

  constructor() {
    const bucket = process.env.PHOTO_UPLOAD_BUCKET;
    if (!bucket) throw new Error("PHOTO_UPLOAD_BUCKET is not set");

    this.bucket = bucket;
    this.client = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
  }

  async createUploadUrl(userId: string, contentType: string): Promise<PhotoUploadUrl> {
    const key = buildPhotoKey(userId, contentType);

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(this.client, command, { expiresIn: UPLOAD_URL_EXPIRY_SECONDS });

    return {
      uploadUrl,
      publicUrl: `https://${this.bucket}.s3.amazonaws.com/${key}`,
    };
  }
}
