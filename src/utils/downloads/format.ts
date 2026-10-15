import { DownloadCommandError } from "./commands";
import type { DownloadErrorCode, DownloadManifest } from "./types";

export function formatBytes(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes))
		return "–";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let v = bytes;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export const formatSpeed = (bps: number | null | undefined) =>
	bps ? `${formatBytes(bps)}/s` : "";

const MESSAGES: Partial<Record<DownloadErrorCode, string>> = {
	network: "Network error. Check your connection and try again",
	unauthorized: "Your session expired. Sign in again to download",
	notFound: "This item no longer exists on the server",
	diskFull: "The disk is full",
	serverRefused: "The server refused the download",
};

export function describeDownloadError(e: unknown): string {
	if (e instanceof DownloadCommandError) {
		if (e.code === "insufficientSpace" || e.code === "io") return e.message;
		return MESSAGES[e.code] ?? e.message;
	}
	if (e instanceof Error) return e.message;
	return String(e);
}

export function manifestErrorText(m: DownloadManifest): string {
	if (!m.error) return "";
	return m.error.code === "network" || m.error.code === "unknown"
		? `${MESSAGES[m.error.code] ?? "Download failed"} (${m.error.message})`
		: (MESSAGES[m.error.code] ?? m.error.message);
}

/** "S1:E2 · Name" for episodes, the name otherwise. */
export function manifestTitle(m: DownloadManifest): string {
	const it = m.item;
	if (it.SeriesId) {
		return `S${it.ParentIndexNumber ?? 0}:E${it.IndexNumber ?? 0} · ${it.Name ?? ""}`;
	}
	return it.Name ?? "Untitled";
}

export function percentDone(
	m: DownloadManifest,
	live?: {
		bytesDone: number;
		bytesTotal: number | null;
		segmentsDone: number | null;
		segmentsTotal: number | null;
	},
): number | null {
	const p = live ?? m.progress;
	if (m.mode === "hls" && p.segmentsTotal) {
		return Math.min(100, ((p.segmentsDone ?? 0) / p.segmentsTotal) * 100);
	}
	if (p.bytesTotal) return Math.min(100, (p.bytesDone / p.bytesTotal) * 100);
	return null;
}

export const downloadedBytes = (m: DownloadManifest) =>
	m.media.sizeBytes ?? m.progress.bytesDone ?? 0;
