import type { DownloadQuality } from "@/utils/downloads/types";

/** Bitrates used for the "compatible copy" (HLS) download qualities. */
export const DOWNLOAD_QUALITY_BITRATES = {
	high: 20_000_000,
	medium: 8_000_000,
	low: 3_000_000,
} as const;

/** Used for "auto" and "original" so the server never caps the original file. */
export const DOWNLOAD_ORIGINAL_MAX_BITRATE = 120_000_000;

export const DOWNLOAD_QUALITY_OPTIONS: {
	value: DownloadQuality;
	label: string;
}[] = [
	{ value: "auto", label: "Auto" },
	{ value: "original", label: "Original" },
	{ value: "high", label: "High · 20 Mbps" },
	{ value: "medium", label: "Medium · 8 Mbps" },
	{ value: "low", label: "Low · 3 Mbps" },
];

/** Extra free space required beyond the expected size (mirrors Rust). */
export const DOWNLOAD_SPACE_MARGIN_BYTES = 200 * 1024 * 1024;

export const DOWNLOAD_NOT_ALLOWED_MESSAGE =
	"Your server administrator has disabled downloads for this account";
