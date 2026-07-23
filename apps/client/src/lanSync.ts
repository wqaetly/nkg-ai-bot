import { invoke } from "@tauri-apps/api/core";
import {
  createMigrationBundle,
  parseMigrationBundle,
  type AppMigrationBundle,
} from "./dataMigration";

export interface LanSyncShareInfo {
  sessionId: string;
  pairingCode: string;
  port: number;
  expiresAt: number;
}

export interface LanSyncShareStatus {
  active: boolean;
  transferred: boolean;
  expiresAt?: number | null;
}

export interface LanSyncOffer {
  kind: "nkg-sync-offer";
  protocol: 1;
  sessionId: string;
  deviceName: string;
  host: string;
  port: number;
  publicKey: string;
  expiresAt: number;
}

export async function startLanSyncShare(): Promise<LanSyncShareInfo> {
  const bundle = await createMigrationBundle();
  return invoke<LanSyncShareInfo>("lan_sync_start_share", {
    payload: JSON.stringify(bundle),
    deviceName: readableDeviceName(),
  });
}

export function cancelLanSyncShare(): Promise<void> {
  return invoke("lan_sync_cancel_share");
}

export function getLanSyncShareStatus(): Promise<LanSyncShareStatus> {
  return invoke("lan_sync_share_status");
}

export function discoverLanSyncDevices(): Promise<LanSyncOffer[]> {
  return invoke("lan_sync_discover");
}

export async function receiveLanSyncBundle(
  offer: LanSyncOffer,
  pairingCode: string,
): Promise<AppMigrationBundle> {
  const contents = await invoke<string>("lan_sync_receive", { offer, pairingCode });
  return parseMigrationBundle(contents);
}

export function isValidPairingCode(value: string): boolean {
  return /^\d{6}$/.test(value);
}

function readableDeviceName(): string {
  const platform = navigator.userAgent.match(/Android/i)
    ? "Android"
    : navigator.userAgent.match(/iPhone|iPad|iPod/i)
      ? "iPhone / iPad"
      : navigator.userAgent.match(/Macintosh/i)
        ? "Mac"
        : navigator.userAgent.match(/Windows/i)
          ? "Windows PC"
          : "NKG 设备";
  return `${platform} · NKG AI Bot`;
}
