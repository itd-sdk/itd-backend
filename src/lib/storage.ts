import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { S3Client } from 'bun'
import { config } from '../config'

export interface Storage {
  put(key: string, data: Uint8Array, contentType: string): Promise<string>
  remove(key: string): Promise<void>
}

class LocalStorage implements Storage {
  readonly root = resolve(config.storage.uploadDir)

  pathFor(key: string) {
    const path = resolve(join(this.root, key))
    if (!path.startsWith(this.root + '/')) throw new Error('Invalid storage key')
    return path
  }

  async put(key: string, data: Uint8Array) {
    const path = this.pathFor(key)
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(path, data)
    return `${config.publicUrl}${config.storage.publicPath}/${key}`
  }

  async remove(key: string) {
    await rm(this.pathFor(key), { force: true })
  }
}

class S3Storage implements Storage {
  private client: S3Client

  constructor() {
    const s3 = config.storage.s3
    if (!s3.bucket) throw new Error('S3_BUCKET is required for STORAGE_DRIVER=s3')
    this.client = new S3Client({
      bucket: s3.bucket,
      endpoint: s3.endpoint,
      region: s3.region,
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey
    })
  }

  async put(key: string, data: Uint8Array, contentType: string) {
    await this.client.write(key, data, { type: contentType, acl: 'public-read' })
    const base = config.storage.s3.publicUrl ?? `${config.storage.s3.endpoint}/${config.storage.s3.bucket}`
    return `${base.replace(/\/$/, '')}/${key}`
  }

  async remove(key: string) {
    await this.client.delete(key)
  }
}

export const localStorage = new LocalStorage()
export const storage: Storage = config.storage.driver === 's3' ? new S3Storage() : localStorage
