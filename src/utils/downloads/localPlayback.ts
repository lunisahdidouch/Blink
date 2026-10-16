import type { Api } from "@jellyfin/sdk";
import {
	type BaseItemDto,
	type MediaStream,
	PlayMethod,
	type UserConfiguration,
} from "@jellyfin/sdk/lib/generated-client";
import { getUserLibraryApi } from "@jellyfin/sdk/lib/utils/api/user-library-api";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import getImageUrlsApi from "@/utils/methods/getImageUrlsApi";
import { pickSubtitle } from "@/utils/methods/trackSelection";
import { useApiInContext } from "@/utils/store/api";
import { useCentralStore } from "@/utils/store/central";
import { playItem, usePlaybackStore } from "@/utils/store/playback";
import useQueue from "@/utils/store/queue";
import { canReportToServer, reportPlaystate } from "./playstate";
import { useDownloadsStore } from "./store";
import type { DownloadManifest, DownloadSubtitleInfo } from "./types";
import { localUrl } from "./urls";

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
	return {
		queue,
		index: Math.max(
			0,
			queue.findIndex((m) => m.id === manifest.id),
		),
	};
}

/** Codec string the player understands for a downloaded subtitle file. */
const playerCodec = (s: DownloadSubtitleInfo) => {
	const ext = s.path?.split(".").pop()?.toLowerCase();
	if (ext === "vtt") return "vtt";
	if (ext === "ass" || ext === "ssa") return ext;
	if (ext === "sup") return "PGSSUB";
	return s.codec;
};

/**
 * Subtitle streams for the player: only tracks that were downloaded, with an absolute
 * local `DeliveryUrl` (the player uses absolute URLs as-is, without `api_key`).
 */
export function localSubtitleStreams(m: DownloadManifest): MediaStream[] {
	const source = m.item.MediaSources?.[0];
	return m.subtitles
		.filter((s) => s.path && !s.unavailable)
		.map((s) => {
			const original = source?.MediaStreams?.find(
				(x) => x.Type === "Subtitle" && x.Index === s.streamIndex,
			);
			return {
				...(original ?? {}),
				Type: "Subtitle",
				Index: s.streamIndex,
				Codec: playerCodec(s),
				Language: s.language ?? original?.Language,
				DisplayTitle:
					s.displayTitle ?? original?.DisplayTitle ?? `Track ${s.streamIndex}`,
				IsDefault: s.isDefault,
				IsForced: s.isForced,
				IsExternal: true,
				DeliveryUrl: localUrl(m, s.path as string),
			} as MediaStream;
		});
}

/** Pick the more recent of the local and server positions. */
export function startPositionFor(
	m: DownloadManifest,
	serverUserData?: BaseItemDto["UserData"] | null,
): number {
	const local = m.userState.played ? 0 : m.userState.positionTicks;
	if (!serverUserData) return local;
	const localTime = m.userState.lastPlayedAt
		? Date.parse(m.userState.lastPlayedAt)
		: 0;
	const serverTime = serverUserData.LastPlayedDate
		? Date.parse(serverUserData.LastPlayedDate)
		: 0;
	return serverTime > localTime
		? (serverUserData.PlaybackPositionTicks ?? 0)
		: local;
}

/**
 * Fill the regular playback store from a manifest so the existing VideoPlayer can play it.
 */
export function initializeLocalPlayback(args: {
	manifest: DownloadManifest;
	queue: DownloadManifest[];
	index: number;
	startPositionTicks?: number;
	userConfig?: UserConfiguration | null;
	subtitleStreamIndex?: number;
}) {
	const { manifest: m, queue, index, userConfig } = args;
	const item = m.item;
	const source = item.MediaSources?.[0];

	let itemName = item.Name ?? "";
	let episodeTitle = "";
	if (item.SeriesId && item.SeriesName) {
		itemName = item.SeriesName;
		episodeTitle = `S${item.ParentIndexNumber ?? 0}:E${item.IndexNumber ?? 0} ${item.Name}`;
	}

	const subtitleStreams = localSubtitleStreams(m);
	const subtitleIndex = pickSubtitle(
		{
			MediaStreams: subtitleStreams,
			DefaultSubtitleStreamIndex: source?.DefaultSubtitleStreamIndex,
		},
		userConfig,
		args.subtitleStreamIndex,
		() => true,
	);
	const chosenSubtitle = subtitleStreams.find((s) => s.Index === subtitleIndex);

	// Only the audio track that was downloaded can play (D11).
	const audioTracks =
		source?.MediaStreams?.filter((s) => s.Type === "Audio") ?? [];
	const audioIndex = m.media.audioStreamIndex ?? audioTracks[0]?.Index ?? 0;
	const audioTrack = audioTracks.filter((t) => t.Index === audioIndex);

	const start = args.startPositionTicks ?? startPositionFor(m);

	playItem({
		origin: "local",
		localDownloadId: m.id,
		localQueue: queue.map((q) => q.id),
		metadata: {
			itemName,
			episodeTitle,
			isEpisode: !!item.SeriesId,
			itemDuration: item.RunTimeTicks ?? 0,
			item,
			mediaSegments: m.mediaSegments ?? undefined,
			userDataLastPlayedPositionTicks: start,
		},
		mediaSource: {
			videoTrack:
				source?.MediaStreams?.find((s) => s.Type === "Video")?.Index ?? 0,
			audioTrack: audioIndex,
			container: m.media.container,
			id: m.mediaSourceId,
			subtitle: {
				url: chosenSubtitle?.DeliveryUrl,
				track: subtitleIndex,
				format: chosenSubtitle?.Codec ?? "nosub",
				allTracks: subtitleStreams,
				enable: subtitleIndex !== -1,
			},
			audio: { track: audioIndex, allTracks: audioTrack },
			bitrate: m.media.bitrate ?? undefined,
			videoCodec: m.media.videoCodec ?? undefined,
			audioCodec: m.media.audioCodec ?? undefined,
			playMethod: PlayMethod.DirectPlay,
			transcodingUrl: undefined,
		},
		// For HLS downloads this ends in .m3u8, so react-player uses hls.js as for transcodes.
		playbackStream: localUrl(m, m.media.path),
		// Must be unique: <ReactPlayer key={playsessionId}> remounts on change.
		playsessionId: `local-${crypto.randomUUID()}`,
		userDataPlayedPositionTicks: start,
		userId: m.userId,
		queueItems: queue.map((q) => q.item),
		queueItemIndex: index,
	});
}

/** Server UserData for the start position, when the same server is reachable. */
async function fetchServerUserData(api: Api | undefined, m: DownloadManifest) {
	if (!api || !(await canReportToServer(api, m))) return null;
	try {
		const res = await getUserLibraryApi(api).getItem(
			{ itemId: m.itemId, userId: m.userId },
			{ timeout: 3000 },
		);
		return res.data.UserData ?? null;
	} catch {
		return null;
	}
}

/** `playItemFromQueue` for local playback: next/previous among downloaded episodes. */
export async function playLocalFromQueue(
	index: "next" | "previous" | number,
	api: Api | undefined,
) {
	const { tracks, currentItemIndex } = useQueue.getState();
	const requested =
		index === "next"
			? currentItemIndex + 1
			: index === "previous"
				? currentItemIndex - 1
				: index;
	const target = tracks?.[requested];
	const playback = usePlaybackStore.getState();
	const current = playback.localDownloadId
		? useDownloadsStore.getState().items[playback.localDownloadId]
		: undefined;
	if (!target?.Id || !current) return;
	const items = useDownloadsStore.getState().items;
	const byItemId = (id: string | undefined) =>
		Object.values(items).find(
			(m) => m.serverId === current.serverId && m.itemId === id,
		);
	const manifest = byItemId(target.Id);
	if (!manifest || manifest.status !== "completed") {
		console.error("The next item is not downloaded");
		return;
	}
	// Save the outgoing item's position first.
	await reportPlaystate("stop", api, playback.getCurrentTime() * 10_000_000);
	const queue = (tracks ?? [])
		.map((t) => byItemId(t.Id))
		.filter((m): m is DownloadManifest => !!m);
	const serverUserData = await fetchServerUserData(api, manifest);
	initializeLocalPlayback({
		manifest,
		queue,
		index: Math.max(
			0,
			queue.findIndex((q) => q.id === manifest.id),
		),
		startPositionTicks: startPositionFor(manifest, serverUserData),
	});
	return "playing";
}

/** Start local playback of a completed download and open the local player route. */
export function usePlayDownloaded() {
	const navigate = useNavigate();
	const api = useApiInContext((s) => s.api);
	const user = useCentralStore((s) => s.currentUser);
	return useCallback(
		async (manifest: DownloadManifest) => {
			const { queue, index } = buildLocalQueue(manifest);
			const serverUserData = await fetchServerUserData(api, manifest);
			initializeLocalPlayback({
				manifest,
				queue,
				index,
				startPositionTicks: startPositionFor(manifest, serverUserData),
				userConfig: user?.Id === manifest.userId ? user?.Configuration : null,
			});
			await navigate({ to: "/local/player" });
		},
		[api, user, navigate],
	);
}

/**
 * Primary image for an item in the player (up-next card, media session artwork):
 * the downloaded image when playing locally, the server image otherwise.
 */
export function getPlaybackImageUrl(
	item: Pick<BaseItemDto, "Id" | "ImageTags"> | undefined,
	api: Api | undefined,
	options: { quality?: number; fillWidth?: number } = {},
): string | undefined {
	if (!item?.Id) return undefined;
	const playback = usePlaybackStore.getState();
	if (playback.origin === "local") {
		const items = useDownloadsStore.getState().items;
		const serverId = playback.localDownloadId?.split(":")[0];
		const m = Object.values(items).find(
			(x) => x.serverId === serverId && x.itemId === item.Id,
		);
		return m?.images.primary ? localUrl(m, m.images.primary) : undefined;
	}
	if (!api) return undefined;
	return getImageUrlsApi(api).getItemImageUrlById(item.Id, "Primary", {
		tag: item.ImageTags?.Primary,
		...options,
	});
}
