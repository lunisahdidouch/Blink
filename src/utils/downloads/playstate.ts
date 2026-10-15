import type { Api } from "@jellyfin/sdk";
import { PlayMethod, RepeatMode } from "@jellyfin/sdk/lib/generated-client";
import { getPlaystateApi } from "@jellyfin/sdk/lib/utils/api/playstate-api";
import { getDefaultServer } from "@/utils/storage/servers";
import { getUser } from "@/utils/storage/user";
import { usePlaybackStore } from "@/utils/store/playback";
import { useDownloadsStore } from "./store";
import type { DownloadManifest, DownloadUserState } from "./types";

export type PlaystateEvent = "start" | "progress" | "pause" | "stop" | "ended";

/** Local position is saved at most this often while playing (plus on pause/stop/end). */
const LOCAL_SAVE_INTERVAL_MS = 10_000;
/** Watching past this share of the runtime counts as played. */
const PLAYED_THRESHOLD = 0.9;
const REPORT_TIMEOUT_MS = 5_000;

let lastLocalSave = 0;

/**
 * Report playback state for whatever is playing. Streaming ("server") behaves exactly as
 * before; local playback saves into the manifest and also reports to the server when it is
 * the same server+user and reachable (otherwise `pendingSync` is set). Never throws.
 */
export async function reportPlaystate(
	event: PlaystateEvent,
	api: Api | undefined,
	positionTicks: number,
): Promise<void> {
	// Snapshot synchronously: callers may reset the store right after calling this.
	const s = usePlaybackStore.getState();
	try {
		if (s.origin === "local") {
			await saveLocal(event, api, positionTicks, s.localDownloadId);
			return;
		}
		if (!api) {
			console.warn(`API is not available, cannot report playback ${event}.`);
			return;
		}
		const common = {
			ItemId: s.metadata.item?.Id,
			MediaSourceId: s.mediaSource.id,
			PlaySessionId: s.playsessionId,
		};
		const info = {
			...common,
			AudioStreamIndex: s.mediaSource.audioTrack,
			CanSeek: true,
			IsMuted: s.playerState.isPlayerMuted,
			IsPaused: !s.playerState.isPlayerPlaying,
			PlayMethod: s.mediaSource.playMethod,
			PlaybackStartTimeTicks: s.metadata.userDataLastPlayedPositionTicks,
			PositionTicks: positionTicks,
			RepeatMode: RepeatMode.RepeatNone,
			VolumeLevel: Math.floor(s.playerState.volume * 100),
		};
		switch (event) {
			case "start":
				await getPlaystateApi(api).reportPlaybackStart({
					playbackStartInfo: { ...info, IsMuted: false, IsPaused: false },
				});
				break;
			case "progress":
				await getPlaystateApi(api).reportPlaybackProgress({
					playbackProgressInfo: info,
				});
				break;
			case "pause":
				await getPlaystateApi(api).reportPlaybackProgress({
					playbackProgressInfo: { ...info, IsPaused: true },
				});
				break;
			case "stop":
				await getPlaystateApi(api).reportPlaybackStopped({
					playbackStopInfo: {
						...common,
						Failed: false,
						PositionTicks: positionTicks,
					},
				});
				break;
			case "ended":
				// Streaming reports the stop when the next item starts or the player exits.
				break;
		}
	} catch (error) {
		console.error(`Failed to report playback ${event}`, error);
	}
}

/** The manifest's server and user are the ones we're signed in to. */
export async function canReportToServer(
	api: Api | undefined,
	m: Pick<DownloadManifest, "serverId" | "userId">,
): Promise<boolean> {
	if (!api?.accessToken) return false;
	const [serverId, user] = await Promise.all([getDefaultServer(), getUser()]);
	return serverId === m.serverId && user?.Id === m.userId;
}

async function reportLocalToServer(
	event: PlaystateEvent,
	api: Api | undefined,
	m: DownloadManifest,
	positionTicks: number,
): Promise<boolean> {
	if (!api || !(await canReportToServer(api, m))) return false;
	const common = {
		ItemId: m.itemId,
		MediaSourceId: m.mediaSourceId,
		PlaySessionId: null,
	};
	const options = { timeout: REPORT_TIMEOUT_MS };
	try {
		const playstate = getPlaystateApi(api);
		if (event === "start") {
			await playstate.reportPlaybackStart(
				{
					playbackStartInfo: {
						...common,
						CanSeek: true,
						IsPaused: false,
						PlayMethod: PlayMethod.DirectPlay,
						PositionTicks: positionTicks,
						AudioStreamIndex: m.media.audioStreamIndex,
					},
				},
				options,
			);
		} else if (event === "progress" || event === "pause") {
			await playstate.reportPlaybackProgress(
				{
					playbackProgressInfo: {
						...common,
						CanSeek: true,
						IsPaused: event === "pause",
						PlayMethod: PlayMethod.DirectPlay,
						PositionTicks: positionTicks,
						AudioStreamIndex: m.media.audioStreamIndex,
					},
				},
				options,
			);
		} else {
			await playstate.reportPlaybackStopped(
				{
					playbackStopInfo: {
						...common,
						Failed: false,
						PositionTicks: positionTicks,
					},
				},
				options,
			);
		}
		return true;
	} catch (error) {
		console.warn("Could not report local playback to the server", error);
		return false;
	}
}

export function nextUserState(
	prev: DownloadUserState,
	event: PlaystateEvent,
	positionTicks: number,
	runTimeTicks: number | null | undefined,
	now = new Date(),
): DownloadUserState {
	const runtime = runTimeTicks ?? 0;
	const finished =
		event === "ended" ||
		(runtime > 0 && positionTicks >= runtime * PLAYED_THRESHOLD);
	return {
		positionTicks: finished ? 0 : Math.max(0, Math.round(positionTicks)),
		played: finished || prev.played,
		lastPlayedAt: now.toISOString(),
		pendingSync: true,
	};
}

/** Per-download queue so saves apply in order even when a server report is slow. */
const saveQueues = new Map<string, Promise<void>>();

function enqueueSave(id: string, task: () => Promise<void>): Promise<void> {
	const previous = saveQueues.get(id) ?? Promise.resolve();
	const next = previous.then(task, task);
	saveQueues.set(
		id,
		next.catch(() => undefined),
	);
	return next;
}

async function saveLocal(
	event: PlaystateEvent,
	api: Api | undefined,
	positionTicks: number,
	id: string | null,
) {
	if (!id) return;
	if (event === "start") {
		const m = useDownloadsStore.getState().items[id];
		// Nothing changed locally yet; just tell the server if we can.
		if (m) await reportLocalToServer("start", api, m, positionTicks);
		return;
	}
	const now = Date.now();
	if (event === "progress" && now - lastLocalSave < LOCAL_SAVE_INTERVAL_MS)
		return;
	lastLocalSave = now;

	await enqueueSave(id, async () => {
		const store = useDownloadsStore.getState();
		const m = store.items[id];
		if (!m) return;
		const userState = nextUserState(
			m.userState,
			event,
			positionTicks,
			m.item.RunTimeTicks,
		);
		// Local first, so nothing is lost if the server is slow or unreachable.
		await store.updateUserState(id, userState);
		const reportTicks =
			userState.played && userState.positionTicks === 0
				? (m.item.RunTimeTicks ?? positionTicks)
				: positionTicks;
		if (await reportLocalToServer(event, api, m, reportTicks)) {
			const latest = useDownloadsStore.getState().items[id]?.userState;
			if (latest?.lastPlayedAt === userState.lastPlayedAt) {
				await store.updateUserState(id, { ...userState, pendingSync: false });
			}
		}
	});
}
