import { useDownloadsStore } from "./store";
import type { DownloadManifest } from "./types";

const episodeOrder = (a: DownloadManifest, b: DownloadManifest) =>
	(a.item.ParentIndexNumber ?? 0) - (b.item.ParentIndexNumber ?? 0) ||
	(a.item.IndexNumber ?? 0) - (b.item.IndexNumber ?? 0) ||
	(a.item.Name ?? "").localeCompare(b.item.Name ?? "");

/**
 * Next-episode queue for local playback: completed downloads of the same series on the
 * same server, sorted by (season, episode). A movie gets a queue of one.
 */
export function buildLocalQueue(
	manifest: DownloadManifest,
	all: DownloadManifest[] = Object.values(useDownloadsStore.getState().items),
): { queue: DownloadManifest[]; index: number } {
	const seriesId = manifest.item.SeriesId;
	if (!seriesId) return { queue: [manifest], index: 0 };
	const queue = all
		.filter(
			(m) =>
				(m.status === "completed" || m.id === manifest.id) &&
				m.serverId === manifest.serverId &&
				m.item.SeriesId === seriesId,
		)
		.sort(episodeOrder);
	return { queue, index: Math.max(0, queue.findIndex((m) => m.id === manifest.id)) };
}
