import { appDataDir, join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { Stronghold, type Client, type Store } from "@tauri-apps/plugin-stronghold";

const CLIENT_NAME = "nkg-ai-bot";

export interface ApiKeyVault {
  setApiKey(reference: string, apiKey: string): Promise<void>;
  getApiKey(reference: string): Promise<string | undefined>;
  removeApiKey(reference: string): Promise<void>;
  lock(): Promise<void>;
}

export class SecretVault implements ApiKeyVault {
  private constructor(
    private readonly stronghold: Stronghold,
    private readonly store: Store,
  ) {}

  static async openAutomatically(
    getDevicePassword: () => Promise<string> = () => invoke<string>("secret_vault_device_password"),
  ): Promise<SecretVault> {
    const password = await getDevicePassword();
    if (password.length < 64) throw new Error("应用生成的设备密钥无效");
    const vaultPath = await join(await appDataDir(), "secrets-auto.hold");
    let stronghold: Stronghold;
    try {
      stronghold = await Stronghold.load(vaultPath, password);
    } catch {
      throw new Error("无法打开自动加密存储，请检查本机应用数据目录权限");
    }
    let client: Client;
    try {
      client = await stronghold.loadClient(CLIENT_NAME);
    } catch {
      try {
        client = await stronghold.createClient(CLIENT_NAME);
      } catch {
        await stronghold.unload().catch(() => undefined);
        throw new Error("自动加密存储已打开，但无法初始化；请检查本机存储空间和文件权限");
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
