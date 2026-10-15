import { load } from "@tauri-apps/plugin-store";
import type { DownloadQuality } from "../downloads/types";

const DownloadsStore = await load(".downloads.dat", {
	autoSave: true,
	defaults: {},
});

export interface DownloadSettings {
	/** null = default folder under the app's local data dir */
	root: string | null;
	/** Play the downloaded copy instead of streaming when one exists */
	preferLocal: boolean;
	defaultQuality: DownloadQuality;
	/** When false, the download button skips the dialog */
	askEachTime: boolean;
}

export const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettings = {
	root: null,
	preferLocal: true,
	defaultQuality: "auto",
	askEachTime: true,
};

export const getDownloadSettings = async (): Promise<DownloadSettings> => {
	const entries = await Promise.all(
		(Object.keys(DEFAULT_DOWNLOAD_SETTINGS) as (keyof DownloadSettings)[]).map(
			async (key) => [key, await DownloadsStore.get(key)] as const,
		),
	);
	const out = { ...DEFAULT_DOWNLOAD_SETTINGS } as Record<string, unknown>;
	for (const [key, value] of entries) {
		if (value !== undefined && value !== null) out[key] = value;
	}
	return out as unknown as DownloadSettings;
};

export const setDownloadSetting = async <K extends keyof DownloadSettings>(
	key: K,
	value: DownloadSettings[K],
) => {
	await DownloadsStore.set(key, value);
	await DownloadsStore.save();
};
