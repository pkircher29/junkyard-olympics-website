import { createHash, randomUUID } from "node:crypto";
import { chmodSync, constants, lstatSync, mkdirSync } from "node:fs";
import { open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp, { type Metadata, type OutputInfo } from "sharp";

export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const PHOTO_MAX_PIXELS = 20_000_000;
export const PHOTO_MAX_EDGE = 1600;

export class PhotoStorageError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "PhotoStorageError";
  }
}

export interface NormalizedPhoto {
  absolutePath: string;
  relativePath: string;
  contentHash: string;
  width: number;
  height: number;
  format: "webp";
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const details = lstatSync(directory);
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Error(`unsafe photo runtime directory: ${directory}`);
  chmodSync(directory, 0o700);
}

function validateCompleteEnvelope(input: Buffer): void {
  if (input.length < 12) throw new PhotoStorageError("INVALID_IMAGE", "image is malformed or truncated");
  const jpeg = input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff;
  const png = input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = input.subarray(0, 4).toString("ascii") === "RIFF" && input.subarray(8, 12).toString("ascii") === "WEBP";
  if (jpeg) {
    if (input[input.length - 2] !== 0xff || input[input.length - 1] !== 0xd9)
      throw new PhotoStorageError("INVALID_IMAGE", "JPEG is truncated or contains trailing data");
    return;
  }
  if (png) {
    const trailer = input.subarray(input.length - 12);
    if (trailer.readUInt32BE(0) !== 0 || trailer.subarray(4, 8).toString("ascii") !== "IEND")
      throw new PhotoStorageError("INVALID_IMAGE", "PNG is truncated or contains trailing data");
    return;
  }
  if (webp) {
    if (input.readUInt32LE(4) + 8 !== input.length)
      throw new PhotoStorageError("INVALID_IMAGE", "WebP is truncated or contains trailing data");
    return;
  }
  throw new PhotoStorageError("UNSUPPORTED_IMAGE", "only JPEG, PNG and WebP images are accepted");
}

export function createPhotoStorage(dataDir: string) {
  const root = path.resolve(dataDir, "photos");
  const originals = path.join(root, "originals");
  const plaques = path.join(root, "plaques");
  const quarantine = path.join(root, "quarantine");
  const exportsDirectory = path.join(root, "exports");
  for (const directory of [root, originals, plaques, quarantine, exportsDirectory])
    ensurePrivateDirectory(directory);

  const storedPath = (relativePath: string): string => {
    if (typeof relativePath !== "string" || !/^photos\/(quarantine|plaques)\/[a-f0-9-]{36}\.webp$/.test(relativePath))
      throw new PhotoStorageError("INVALID_PHOTO_PATH", "photo path is not server-owned");
    const resolved = path.resolve(dataDir, relativePath);
    const parent = path.dirname(resolved);
    if (![quarantine, plaques].includes(parent))
      throw new PhotoStorageError("INVALID_PHOTO_PATH", "photo path is not server-owned");
    return resolved;
  };

  return {
    root,
    async normalize(input: Buffer): Promise<NormalizedPhoto> {
      if (!Buffer.isBuffer(input) || input.length === 0)
        throw new PhotoStorageError("INVALID_IMAGE", "an image file is required");
      if (input.length > PHOTO_MAX_BYTES)
        throw new PhotoStorageError("PHOTO_TOO_LARGE", "image exceeds the 8 MiB upload limit", 413);
      validateCompleteEnvelope(input);

      let metadata: Metadata;
      try {
        metadata = await sharp(input, {
          animated: true,
          failOn: "error",
          limitInputPixels: PHOTO_MAX_PIXELS,
        }).metadata();
      } catch {
        throw new PhotoStorageError("INVALID_IMAGE", "image could not be decoded within safety limits");
      }
      if (!["jpeg", "png", "webp"].includes(metadata.format ?? ""))
        throw new PhotoStorageError("UNSUPPORTED_IMAGE", "only JPEG, PNG and WebP images are accepted");
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > PHOTO_MAX_PIXELS)
        throw new PhotoStorageError("PHOTO_PIXEL_LIMIT", "image exceeds the 20 megapixel decoded limit", 413);
      if ((metadata.pages ?? 1) !== 1)
        throw new PhotoStorageError("ANIMATED_IMAGE", "animated or multi-page images are not accepted");

      let output: { data: Buffer; info: OutputInfo };
      try {
        output = await sharp(input, {
          animated: false,
          failOn: "error",
          limitInputPixels: PHOTO_MAX_PIXELS,
        })
          .rotate()
          .resize({ width: PHOTO_MAX_EDGE, height: PHOTO_MAX_EDGE, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 86, effort: 4 })
          .toBuffer({ resolveWithObject: true });
      } catch {
        throw new PhotoStorageError("INVALID_IMAGE", "image could not be fully decoded and normalized");
      }
      if (!output.info.width || !output.info.height || output.info.width > PHOTO_MAX_EDGE || output.info.height > PHOTO_MAX_EDGE)
        throw new PhotoStorageError("INVALID_IMAGE", "normalized image dimensions are invalid");

      const id = randomUUID();
      const filename = `${id}.webp`;
      const absolutePath = path.join(quarantine, filename);
      const temporary = path.join(quarantine, `.${id}.tmp`);
      try {
        await writeFile(temporary, output.data, { mode: 0o600, flag: "wx" });
        await rename(temporary, absolutePath);
      } finally {
        await rm(temporary, { force: true });
      }
      return {
        absolutePath,
        relativePath: path.posix.join("photos", "quarantine", filename),
        contentHash: createHash("sha256").update(output.data).digest("hex"),
        width: output.info.width,
        height: output.info.height,
        format: "webp",
      };
    },
    async remove(normalizedPath: string): Promise<void> {
      const resolved = path.resolve(normalizedPath);
      if (path.dirname(resolved) !== quarantine || !/^[a-f0-9-]{36}\.webp$/.test(path.basename(resolved)))
        throw new PhotoStorageError("INVALID_PHOTO_PATH", "photo path is not server-owned");
      await rm(resolved, { force: true });
    },
    async readStored(relativePath: string): Promise<Buffer> {
      const handle = await open(storedPath(relativePath), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const details = await handle.stat();
        if (!details.isFile() || details.size > PHOTO_MAX_BYTES)
          throw new PhotoStorageError("INVALID_PHOTO_FILE", "photo file is unavailable");
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    },
    async removeStored(relativePath: string | null | undefined): Promise<void> {
      if (!relativePath) return;
      await rm(storedPath(relativePath), { force: true });
    },
  };
}
