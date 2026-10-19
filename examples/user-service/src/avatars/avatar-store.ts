import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { HttpError, Singleton, Value, type UploadedFile } from 'amoxi';

const TYPES: Array<{ ext: string; type: string; magic: (b: Buffer) => boolean }> = [
  { ext: 'png', type: 'image/png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', type: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', type: 'image/gif', magic: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { ext: 'webp', type: 'image/webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

/** Profile photos on disk, one per person. File types are checked by their bytes, not the client's claim. */
@Singleton()
export class AvatarStore {
  private readonly dir: string;

  constructor(
    @Value('${avatars.dir:data/avatars}') dir: string,
    @Value('${avatars.max-bytes:2097152}') private readonly maxBytes: number,
  ) {
    this.dir = path.resolve(dir);
  }

  find(id: number): { path: string; type: string; version: number } | undefined {
    for (const t of TYPES) {
      const file = path.join(this.dir, `${id}.${t.ext}`);
      if (existsSync(file)) return { path: file, type: t.type, version: Math.floor(statSync(file).mtimeMs) };
    }
    return undefined;
  }

  async save(id: number, upload: UploadedFile): Promise<void> {
    if (upload.size > this.maxBytes) throw new HttpError(413, `Photos can be at most ${Math.round(this.maxBytes / 1024 / 1024)} MB`);
    const head = (await upload.read()).subarray(0, 16);
    const type = TYPES.find((t) => t.magic(head));
    if (!type) throw new HttpError(415, 'Upload a PNG, JPEG, GIF or WebP image');
    this.remove(id);
    await upload.moveTo(path.join(this.dir, `${id}.${type.ext}`));
  }

  remove(id: number): void {
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) if (f.startsWith(`${id}.`)) rmSync(path.join(this.dir, f), { force: true });
  }
}
