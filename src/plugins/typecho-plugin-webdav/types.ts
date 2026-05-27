export type StorageProvider = 's3' | 'r2' | 'tianyi';

export interface WebDavConfig {
  routePath: string;
  protocolEnabled: boolean;
  mounts: StorageMount[];
  failBanEnabled: boolean;
  failBanMaxFailures: number;
  failBanWindowSeconds: number;
  failBanSeconds: number;
  fileListPageSize: number;
}

export interface StorageMount {
  mount: string;
  provider: StorageProvider;
  bindingName: string;
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  pathStyle: boolean;
  username: string;
  password: string;
  rootDir: string;
  sessionCookie: string;
  _folderCache?: Map<string, string>;
}

export interface WebDavStorageAdapter {
  list(path: string, workerEnv?: Record<string, unknown>, limit?: number, offset?: number): Promise<S3ListResult>;
  meta(path: string, workerEnv?: Record<string, unknown>): Promise<S3Object | null>;
  read(path: string, workerEnv?: Record<string, unknown>): Promise<Response>;
  write(path: string, body: ReadableStream<Uint8Array> | null, contentType: string, workerEnv?: Record<string, unknown>): Promise<Response>;
  mkdir(path: string, workerEnv?: Record<string, unknown>): Promise<Response>;
  delete(path: string, workerEnv?: Record<string, unknown>): Promise<Response>;
  getMounts(): { name: string; provider: string }[];
}

export interface S3Object {
  key: string;
  size: number;
  etag: string;
  lastModified: string;
}

export interface S3ListResult {
  objects: S3Object[];
  prefixes: string[];
  total?: number;
}

export const PLUGIN_ID = 'typecho-plugin-webdav';
