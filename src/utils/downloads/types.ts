/**
 * Mirrors `src-tauri/src/downloads/model.rs` (serde camelCase). Keep both in sync.
 */
import type {
	BaseItemDto,
	MediaSegmentDtoQueryResult,
} from "@jellyfin/sdk/lib/generated-client";

export type DownloadStatus =
	| "queued"
	| "downloading"
	| "paused"
	| "completed"
	| "failed";

export type DownloadMode = "file" | "hls";

export type DownloadErrorCode =
	| "network"
	| "unauthorized"
	| "notFound"
	| "diskFull"
	| "insufficientSpace"
	| "serverRefused"
	| "io"
	| "cancelled"
	| "unknown";

export interface DownloadErrorInfo {
	code: DownloadErrorCode;
	message: string;
}

export interface DownloadProgress {
	bytesDone: number;
	bytesTotal: number | null;
	segmentsDone: number | null;
	segmentsTotal: number | null;
}

export interface DownloadUserState {
	positionTicks: number;
	played: boolean;
	/** RFC3339 */
	lastPlayedAt: string | null;
	pendingSync: boolean;
}

export interface DownloadMediaInfo {
	/** Relative to the item folder: `media.{container}` or `hls/index.m3u8`. */
	path: string;
	container: string;
	videoCodec: string | null;
	audioCodec: string | null;
	bitrate: number | null;
	audioStreamIndex: number | null;
	sizeBytes: number | null;
}

export interface DownloadSubtitleInfo {
	streamIndex: number;
	codec: string;
	language: string | null;
	displayTitle: string | null;
	isDefault: boolean;
	isForced: boolean;
	/** `subs/{index}.{ext}` once downloaded */
	path: string | null;
	unavailable: boolean;
}

export interface DownloadImages {
	primary: string | null;
	seriesPrimary: string | null;
	backdrop: string | null;
}

export type DownloadQuality = "auto" | "original" | "high" | "medium" | "low";

export interface DownloadHlsInfo {
	quality: DownloadQuality;
	maxBitrate: number | null;
	segmentCount: number | null;
	playSessionId: string | null;
}

export interface DownloadManifest {
	schemaVersion: number;
	/** `"{serverId}:{itemId}"` */
	id: string;
	serverId: string;
	serverName: string;
	serverAddress: string;
	userId: string;
	itemId: string;
	mediaSourceId: string;
	mode: DownloadMode;
	media: DownloadMediaInfo;
	subtitles: DownloadSubtitleInfo[];
	images: DownloadImages;
	/** Trimmed BaseItemDto (see trimItem.ts) */
	item: BaseItemDto;
	mediaSegments: MediaSegmentDtoQueryResult | null;
	hls: DownloadHlsInfo | null;
	status: DownloadStatus;
	error: DownloadErrorInfo | null;
	progress: DownloadProgress;
	userState: DownloadUserState;
	createdAt: string;
	completedAt: string | null;
}

export interface AssetSpec {
	url: string;
	relPath: string;
}

export interface JobSpec {
	/** status/progress/error/userState are ignored by Rust on input */
	manifest: DownloadManifest;
	/** `api.authorizationHeader`; never persisted */
	authHeader: string;
	mediaUrl: string;
	assets: AssetSpec[];
	expectedBytes: number | null;
	basePath: string | null;
	deviceId: string | null;
}

export interface ProgressEvent {
	id: string;
	bytesDone: number;
	bytesTotal: number | null;
	segmentsDone: number | null;
	segmentsTotal: number | null;
	speedBps: number;
}

export interface InitInfo {
	root: string;
	mediaBaseUrl: string;
}

export const downloadId = (serverId: string, itemId: string) =>
	`${serverId}:${itemId}`;

export const isActiveStatus = (s: DownloadStatus) =>
	s === "queued" || s === "downloading" || s === "paused" || s === "failed";
