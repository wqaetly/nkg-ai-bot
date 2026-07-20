import { appDataDir, join } from "@tauri-apps/api/path";
import { Stronghold, type Client, type Store } from "@tauri-apps/plugin-stronghold";

const CLIENT_NAME = "nkg-ai-bot";

export interface ApiKeyVault {
  setApiKey(reference: string, apiKey: string): Promise<void>;
  getApiKey(reference: string): Promise<string | undefined>;
  removeApiKey(reference: string): Promise<void>;
  lock(): Promise<void>;
}

export class VaultUnlockError extends Error {
  readonly code = "vault.unlock_failed";

  constructor(
    message = "无法解锁本地密钥库。若此前已创建，请检查密码；若密码正确，密钥库快照可能已损坏或不可访问。",
  ) {
    super(message);
    this.name = "VaultUnlockError";
  }
}

export class SecretVault implements ApiKeyVault {
  private constructor(
    private readonly stronghold: Stronghold,
    private readonly store: Store,
  ) {}

  static async unlock(password: string): Promise<SecretVault> {
    if (password.length < 8) {
      throw new Error("本地密钥库密码至少需要 8 个字符");
    }
    const vaultPath = await join(await appDataDir(), "secrets.hold");
    let stronghold: Stronghold;
    try {
      stronghold = await Stronghold.load(vaultPath, password);
    } catch {
      throw new VaultUnlockError();
    }
    let client: Client;
    try {
      client = await stronghold.loadClient(CLIENT_NAME);
    } catch {
      try {
        client = await stronghold.createClient(CLIENT_NAME);
      } catch {
        await stronghold.unload().catch(() => undefined);
        throw new VaultUnlockError("本地密钥库已打开，但无法初始化加密存储。请检查本机存储空间和文件权限。");
      }
    }
    return new SecretVault(stronghold, client.getStore());
  }

  async setApiKey(reference: string, apiKey: string): Promise<void> {
    if (!reference.trim() || !apiKey.trim()) throw new Error("API Key reference and value are required");
    await this.store.insert(reference, Array.from(new TextEncoder().encode(apiKey.trim())));
    await this.stronghold.save();
  }

  async getApiKey(reference: string): Promise<string | undefined> {
    const value = await this.store.get(reference);
    return value === null ? undefined : new TextDecoder().decode(value);
  }

  async removeApiKey(reference: string): Promise<void> {
    await this.store.remove(reference);
    await this.stronghold.save();
  }

  async lock(): Promise<void> {
    await this.stronghold.unload();
  }
}
