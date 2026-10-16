import type { Api } from "@jellyfin/sdk";
import {
	type BaseItemDto,
	BaseItemKind,
	type DeviceProfile,
	type MediaSegmentDtoQueryResult,
	type MediaSourceInfo,
	type MediaStream,
	type PlaybackInfoResponse,
	type UserDto,
} from "@jellyfin/sdk/lib/generated-client";
import { getMediaInfoApi } from "@jellyfin/sdk/lib/utils/api/media-info-api";
import { getMediaSegmentsApi } from "@jellyfin/sdk/lib/utils/api/media-segments-api";
import { getUserLibraryApi } from "@jellyfin/sdk/lib/utils/api/user-library-api";
import {
	DOWNLOAD_NOT_ALLOWED_MESSAGE,
	DOWNLOAD_ORIGINAL_MAX_BITRATE,
	DOWNLOAD_QUALITY_BITRATES,
} from "@/utils/constants/downloads";
import getImageUrlsApi from "@/utils/methods/getImageUrlsApi";
import { defaultAudioIndex, pickAudio } from "@/utils/methods/trackSelection";
import { trimItem } from "./trimItem";
import type {
	AssetSpec,
	DownloadManifest,
	DownloadMode,
	DownloadQuality,
	DownloadSubtitleInfo,
	JobSpec,
} from "./types";
import { downloadId } from "./types";

export class DownloadNotAllowedError extends Error {
	constructor() {
		super(DOWNLOAD_NOT_ALLOWED_MESSAGE);
		this.name = "DownloadNotAllowedError";
	}
}

export class ServerRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ServerRefusedError";
	}
}

export const canDownload = (user: UserDto | null | undefined) =>
	user?.Policy?.EnableContentDownloading === true;

export const isDownloadableItem = (item: BaseItemDto | undefined | null) =>
	item?.Type === BaseItemKind.Episode || item?.Type === BaseItemKind.Movie;

/**
 * Mode decision table (plan §4.3).
 */
export function chooseMode(args: {
	quality: DownloadQuality;
	supportsDirectPlay: boolean;
	/** a non-default audio track was picked and the file has more than one */
	nonDefaultAudio: boolean;
}): { mode: DownloadMode; mayNotPlay: boolean } {
	const { quality, supportsDirectPlay, nonDefaultAudio } = args;
	if (quality === "high" || quality === "medium" || quality === "low") {
		return { mode: "hls", mayNotPlay: false };
	}
	if (supportsDirectPlay) {
		// The WebView can't switch embedded audio tracks, so bake the choice in via HLS.
		return { mode: nonDefaultAudio ? "hls" : "file", mayNotPlay: false };
	}
	if (quality === "original") {
		return { mode: "file", mayNotPlay: true };
	}
	return { mode: "hls", mayNotPlay: false };
}

/** Subtitle codec → downloaded file extension; null = can't be downloaded. */
export function subtitleExt(codec: string | null | undefined): string | null {
	switch ((codec ?? "").toLowerCase()) {
		case "subrip":
		case "srt":
		case "vtt":
		case "webvtt":
		case "mov_text":
			return "vtt";
		case "ass":
			return "ass";
		case "ssa":
			return "ssa";
		case "pgssub":
		case "pgs":
			return "sup";
		default:
			return null;
	}
}

/**
 * Format to request from `/Subtitles/{index}/0/Stream.{format}`. Jellyfin converts text
 * subtitles to the requested format, but serves PGS only as `pgssub` (`sup` returns 400).
 * The file is still saved as `.sup`.
 */
export function subtitleRequestFormat(ext: string): string {
	return ext === "sup" ? "pgssub" : ext;
}

/** Pick a file extension from Jellyfin's container string (e.g. "mov,mp4,m4a,3gp"). */
export function containerExt(container: string | null | undefined): string {
	const parts = (container ?? "")
		.toLowerCase()
		.split(",")
		.map((p) => p.trim())
		.filter((p) => /^[a-z0-9]{1,8}$/.test(p));
	for (const preferred of ["mp4", "mkv", "webm", "m4v", "mov", "avi", "ts"]) {
		if (parts.includes(preferred)) return preferred;
	}
	return parts[0] ?? "bin";
}

/** Remove `api_key` from a server-relative or absolute URL (auth goes in the header). */
export function stripApiKey(url: string): string {
	const [path, query] = url.split("?");
	if (!query) return url;
	const params = new URLSearchParams(query);
	params.delete("api_key");
	params.delete("ApiKey");
	const q = params.toString();
	return q ? `${path}?${q}` : path;
}

export function buildSubtitles(
	api: Pick<Api, "basePath">,
	itemId: string,
	source: MediaSourceInfo,
): { subtitles: DownloadSubtitleInfo[]; assets: AssetSpec[] } {
	const subtitles: DownloadSubtitleInfo[] = [];
	const assets: AssetSpec[] = [];
	for (const s of source.MediaStreams ?? []) {
		if (s.Type !== "Subtitle" || s.Index === undefined) continue;
		const ext = subtitleExt(s.Codec);
		const relPath = ext ? `subs/${s.Index}.${ext}` : null;
		subtitles.push({
			streamIndex: s.Index,
			codec: s.Codec ?? "",
			language: s.Language ?? null,
			displayTitle: s.DisplayTitle ?? null,
			isDefault: !!s.IsDefault,
			isForced: !!s.IsForced,
			path: relPath,
			unavailable: !relPath,
		});
		if (relPath) {
			assets.push({
				url: `${api.basePath}/Videos/${itemId}/${source.Id}/Subtitles/${s.Index}/0/Stream.${subtitleRequestFormat(ext)}`,
				relPath,
			});
		}
	}
	return { subtitles, assets };
}

export function estimateBytes(
	mode: DownloadMode,
	source: MediaSourceInfo,
	runTimeTicks: number | null | undefined,
	maxBitrate: number | null,
): number | null {
	if (mode === "file") return source.Size ?? null;
	if (!runTimeTicks) return null;
	const bitrate = Math.min(
		maxBitrate ?? Number.POSITIVE_INFINITY,
		source.Bitrate ?? DOWNLOAD_QUALITY_BITRATES.medium,
	);
	return Math.round((bitrate / 8) * (runTimeTicks / 10_000_000) * 1.1);
}

/**
 * Device profile for compatible-copy (HLS) downloads: video may only be transcoded to HLS, so
 * the server can't pick a progressive container (e.g. Blink's MKV streaming profile).
 */
export function hlsOnlyProfile(profile: DeviceProfile): DeviceProfile {
	return {
		...profile,
		TranscodingProfiles: (profile.TranscodingProfiles ?? []).filter(
			(t) => t.Type !== "Video" || t.Protocol === "hls",
		),
	};
}

/** True when a TranscodingUrl points at an HLS playlist. */
export const isHlsUrl = (url: string | null | undefined) =>
	!!url && /\.m3u8(\?|$)/i.test(url);

export interface PlanContext {
	api: Api;
	user: UserDto;
	server: { id: string; name: string; address: string };
	deviceProfile: DeviceProfile;
}

export interface PlanOptions {
	mediaSourceId?: string | null;
	audioStreamIndex?: number | null;
	quality: DownloadQuality;
	/** Keep the mode of an existing download when resuming. */
	forceMode?: DownloadMode;
}

export interface PlannedDownload {
	job: JobSpec;
	mayNotPlay: boolean;
	mode: DownloadMode;
}

async function postedPlaybackInfo(
	ctx: PlanContext,
	itemId: string,
	mediaSourceId: string | undefined,
	audioStreamIndex: number | undefined,
	maxBitrate: number,
	allowDirect: boolean,
	deviceProfile: DeviceProfile = ctx.deviceProfile,
): Promise<PlaybackInfoResponse> {
	const res = await getMediaInfoApi(ctx.api).getPostedPlaybackInfo({
		itemId,
		playbackInfoDto: {
			UserId: ctx.user.Id,
			MediaSourceId: mediaSourceId,
			AudioStreamIndex: audioStreamIndex,
			SubtitleStreamIndex: -1,
			MaxStreamingBitrate: maxBitrate,
			DeviceProfile: deviceProfile,
			EnableDirectPlay: allowDirect,
			EnableDirectStream: allowDirect,
			EnableTranscoding: true,
			AllowVideoStreamCopy: true,
			AllowAudioStreamCopy: true,
		},
	});
	return res.data;
}

/**
 * PlaybackInfo → JobSpec (plan §4.3). Network calls only; nothing is enqueued here.
 */
export async function planDownload(
	ctx: PlanContext,
	itemIn: BaseItemDto,
	options: PlanOptions,
): Promise<PlannedDownload> {
	const { api, user, server } = ctx;
	if (!canDownload(user)) throw new DownloadNotAllowedError();
	if (!itemIn.Id) throw new Error("Item has no id");
	const itemId = itemIn.Id;

	const item = (
		await getUserLibraryApi(api).getItem({ itemId, userId: user.Id })
	).data;

	const firstSource =
		item.MediaSources?.find((s) => s.Id === options.mediaSourceId) ??
		item.MediaSources?.[0];
	if (!firstSource?.Id)
		throw new ServerRefusedError("This item has no media source");
	const mediaSourceId = firstSource.Id;
	const audioIndex = pickAudio(
		firstSource,
		user.Configuration,
		options.audioStreamIndex,
	);
	const audioTracks =
		firstSource.MediaStreams?.filter((s: MediaStream) => s.Type === "Audio") ??
		[];
	const nonDefaultAudio =
		audioTracks.length > 1 && audioIndex !== defaultAudioIndex(firstSource);

	const qualityBitrate =
		options.quality === "high" ||
		options.quality === "medium" ||
		options.quality === "low"
			? DOWNLOAD_QUALITY_BITRATES[options.quality]
			: DOWNLOAD_ORIGINAL_MAX_BITRATE;

	const probe = await postedPlaybackInfo(
		ctx,
		itemId,
		mediaSourceId,
		audioIndex,
		DOWNLOAD_ORIGINAL_MAX_BITRATE,
		true,
	);
	if (probe.ErrorCode) {
		throw new ServerRefusedError(
			`The server refused playback (${probe.ErrorCode})`,
		);
	}
	const probeSource =
		probe.MediaSources?.find((s) => s.Id === mediaSourceId) ??
		probe.MediaSources?.[0] ??
		firstSource;

	let { mode, mayNotPlay } = chooseMode({
		quality: options.quality,
		supportsDirectPlay: !!probeSource.SupportsDirectPlay,
		nonDefaultAudio,
	});
	if (options.forceMode) {
		mode = options.forceMode;
		mayNotPlay = false;
	}

	let mediaUrl: string;
	let playSessionId: string | null = null;
	let maxBitrate: number | null = null;
	let source: MediaSourceInfo = probeSource;
	if (mode === "file") {
		mediaUrl = `${api.basePath}/Items/${itemId}/Download?mediaSourceId=${encodeURIComponent(mediaSourceId)}`;
	} else {
		const info = await postedPlaybackInfo(
			ctx,
			itemId,
			mediaSourceId,
			audioIndex,
			qualityBitrate,
			false,
			hlsOnlyProfile(ctx.deviceProfile),
		);
		const s =
			info.MediaSources?.find((x) => x.Id === mediaSourceId) ??
			info.MediaSources?.[0];
		if (info.ErrorCode || !s?.TranscodingUrl) {
			throw new ServerRefusedError(
				"The server can't make a compatible copy of this item (transcoding or remuxing is disabled for this account)",
			);
		}
		if (!isHlsUrl(s.TranscodingUrl)) {
			throw new ServerRefusedError(
				"The server offered a stream that can't be saved for offline playback (not HLS)",
			);
		}
		source = { ...firstSource, ...s, MediaStreams: firstSource.MediaStreams };
		mediaUrl = stripApiKey(`${api.basePath}${s.TranscodingUrl}`);
		playSessionId = info.PlaySessionId ?? null;
		maxBitrate =
			options.quality === "auto" || options.quality === "original"
				? null
				: qualityBitrate;
	}

	const { subtitles, assets } = buildSubtitles(api, itemId, firstSource);

	// Images
	const images = getImageUrlsApi(api);
	const imageSpec = { quality: 90 };
	const imageRefs: DownloadManifest["images"] = {
		primary: null,
		seriesPrimary: null,
		backdrop: null,
	};
	if (item.ImageTags?.Primary) {
		imageRefs.primary = "images/primary.jpg";
		assets.push({
			url: images.getItemImageUrlById(itemId, "Primary", {
				...imageSpec,
				maxWidth: 800,
			}),
			relPath: imageRefs.primary,
		});
	}
	const isEpisode = item.Type === BaseItemKind.Episode;
	if (isEpisode && item.SeriesId && item.SeriesPrimaryImageTag) {
		imageRefs.seriesPrimary = "images/series-primary.jpg";
		assets.push({
			url: images.getItemImageUrlById(item.SeriesId, "Primary", {
				...imageSpec,
				maxWidth: 800,
			}),
			relPath: imageRefs.seriesPrimary,
		});
	}
	const backdropId = isEpisode
		? (item.ParentBackdropItemId ?? item.SeriesId)
		: item.BackdropImageTags?.length
			? itemId
			: undefined;
	if (backdropId && (isEpisode ? item.ParentBackdropImageTags?.length : true)) {
		imageRefs.backdrop = "images/backdrop.jpg";
		assets.push({
			url: images.getItemImageUrlById(backdropId, "Backdrop", {
				...imageSpec,
				maxWidth: 1920,
			}),
			relPath: imageRefs.backdrop,
		});
	}

	let mediaSegments: MediaSegmentDtoQueryResult | null = null;
	try {
		mediaSegments = (await getMediaSegmentsApi(api).getItemSegments({ itemId }))
			.data;
	} catch {
		// Older servers don't have the endpoint.
		mediaSegments = null;
	}

	const audioStream = audioTracks.find((t) => t.Index === audioIndex);
	const videoStream = firstSource.MediaStreams?.find((s) => s.Type === "Video");
	const container =
		mode === "file" ? containerExt(firstSource.Container) : "hls";
	const manifest: DownloadManifest = {
		schemaVersion: 1,
		id: downloadId(server.id, itemId),
		serverId: server.id,
		serverName: server.name,
		serverAddress: server.address,
		userId: user.Id ?? "",
		itemId,
		mediaSourceId,
		mode,
		media: {
			path: mode === "file" ? `media.${container}` : "hls/index.m3u8",
			container,
			videoCodec: videoStream?.Codec ?? null,
			audioCodec: audioStream?.Codec ?? null,
			bitrate: source.Bitrate ?? null,
			audioStreamIndex: audioIndex,
			sizeBytes: null,
		},
		subtitles,
		images: imageRefs,
		item: trimItem(item, mediaSourceId),
		mediaSegments,
		hls:
			mode === "hls"
				? {
						quality: options.quality,
						maxBitrate,
						segmentCount: null,
						playSessionId,
					}
				: null,
		status: "queued",
		error: null,
		progress: {
			bytesDone: 0,
			bytesTotal: null,
			segmentsDone: null,
			segmentsTotal: null,
		},
		userState: {
			positionTicks: item.UserData?.PlaybackPositionTicks ?? 0,
			played: !!item.UserData?.Played,
			lastPlayedAt: item.UserData?.LastPlayedDate ?? null,
			pendingSync: false,
		},
		createdAt: new Date().toISOString(),
		completedAt: null,
	};

	return {
		mode,
		mayNotPlay,
		job: {
			manifest,
			authHeader: api.authorizationHeader,
			mediaUrl,
			assets,
			expectedBytes: estimateBytes(mode, source, item.RunTimeTicks, maxBitrate),
			basePath: api.basePath,
			deviceId: api.deviceInfo.id,
		},
	};
}

/** Fresh URL + auth for resuming an existing download with the same parameters. */
export async function replanForResume(
	ctx: PlanContext,
	manifest: DownloadManifest,
): Promise<JobSpec> {
	const planned = await planDownload(ctx, manifest.item, {
		mediaSourceId: manifest.mediaSourceId,
		audioStreamIndex: manifest.media.audioStreamIndex,
		quality: manifest.hls?.quality ?? "original",
		forceMode: manifest.mode,
	});
	return planned.job;
}
