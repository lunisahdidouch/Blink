import { useDownloadsStore } from "./store";
import type { DownloadManifest } from "./types";

/** `${mediaBaseUrl}/${serverId}/${itemId}/${rel}` on the loopback media server. */
export const buildLocalUrl = (
	mediaBaseUrl: string,
	manifest: Pick<DownloadManifest, "serverId" | "itemId">,
	rel: string,
) =>
	`${mediaBaseUrl}/${manifest.serverId}/${manifest.itemId}/${rel
		.split("/")
		.map(encodeURIComponent)
		.join("/")}`;

/** Absolute URL of a file inside a download, served by the loopback media server. */
export const localUrl = (
	manifest: Pick<DownloadManifest, "serverId" | "itemId">,
	rel: string,
) => buildLocalUrl(useDownloadsStore.getState().mediaBaseUrl, manifest, rel);
