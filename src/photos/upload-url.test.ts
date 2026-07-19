import { describe, expect, it } from "vitest";
import { buildPhotoKey, extensionFor, FakePhotoUploadUrlProvider } from "./upload-url.js";

describe("buildPhotoKey", () => {
  it("scopes the key under the user's id and the right extension", () => {
    const key = buildPhotoKey("user-1", "image/png");
    expect(key).toMatch(/^profile-photos\/user-1\/[0-9a-f-]+\.png$/);
  });

  it("rejects an unsupported content type", () => {
    expect(() => extensionFor("application/pdf")).toThrow();
  });
});

describe("FakePhotoUploadUrlProvider", () => {
  it("returns an upload url and a matching public url", async () => {
    const provider = new FakePhotoUploadUrlProvider();
    const { uploadUrl, publicUrl } = await provider.createUploadUrl("user-1", "image/jpeg");

    expect(uploadUrl).toContain("profile-photos/user-1/");
    expect(publicUrl).toContain("profile-photos/user-1/");
  });
});
