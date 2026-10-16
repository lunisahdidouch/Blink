import { describe, expect, it, vi } from "vitest";

// The player store, API/user stores and plugin-store storage need a Tauri webview.
vi.mock("@/utils/store/playback", () => ({
	playItem: vi.fn(),
	usePlaybackStore: { getState: () => ({ origin: "server" }) },
}));
vi.mock("@/utils/store/api", () => ({ useApiInContext: vi.fn() }));
vi.mock("@/utils/store/central", () => ({ useCentralStore: vi.fn() }));
vi.mock("@/utils/storage/servers", () => ({ getDefaultServer: vi.fn() }));
vi.mock("@/utils/storage/user", () => ({ getUser: vi.fn() }));

import { playItem } from "@/utils/store/playback";
import {
	buildLocalQueue,
	initializeLocalPlayback,
	localSubtitleStreams,
	startPositionFor,
} from "./localPlayback";
import { nextUserState } from "./playstate";
import { useDownloadsStore } from "./store";
import { resolveSync } from "./sync";
import type { DownloadManifest } from "./types";

const m = (
	id: string,
	season: number,
	episode: number,
	extra: Partial<DownloadManifest> = {},
	seriesId: string | null = "s1",
): DownloadManifest =>
	({
		id: `srv:${id}`,
		serverId: "srv",
		itemId: id,
		status: "completed",
		item: {
			Id: id,
			Name: `E${episode}`,
			SeriesId: seriesId,
			ParentIndexNumber: season,
			IndexNumber: episode,
		},
		...extra,
	}) as DownloadManifest;

describe("buildLocalQueue", () => {
	const e = {
		s2e1: m("a", 2, 1),
		s1e2: m("b", 1, 2),
		s1e10: m("c", 1, 10),
		s1e1: m("d", 1, 1),
		otherSeries: m("e", 1, 3, {}, "s2"),
		otherServer: m("f", 1, 4, { serverId: "other", id: "other:f" }),
		notDone: m("g", 1, 5, { status: "paused" }),
	};
	const all = Object.values(e);

	it("sorts completed episodes of the same series by season, then episode", () => {
		const { queue, index } = buildLocalQueue(e.s1e2, all);
		expect(queue.map((q) => q.itemId)).toEqual(["d", "b", "c", "a"]);
		expect(index).toBe(1);
	});

	it("gives a movie a queue of one", () => {
		const movie = m("mv", 0, 0, {}, null);
		expect(buildLocalQueue(movie, [movie, ...all])).toEqual({
			queue: [movie],
			index: 0,
		});
	});
});

const full = (): DownloadManifest =>
	m("ep", 1, 2, {
		mediaSourceId: "ms",
		mode: "hls",
		media: {
			path: "hls/index.m3u8",
			container: "hls",
			videoCodec: "h264",
			audioCodec: "aac",
			bitrate: 1,
			audioStreamIndex: 2,
			sizeBytes: 10,
		},
		subtitles: [
			{
				streamIndex: 3,
				codec: "subrip",
				language: "eng",
				displayTitle: "English",
				isDefault: false,
				isForced: false,
				path: "subs/3.vtt",
				unavailable: false,
			},
			{
				streamIndex: 4,
				codec: "ass",
				language: "jpn",
				displayTitle: null,
				isDefault: true,
				isForced: false,
				path: "subs/4.ass",
				unavailable: false,
			},
			{
				streamIndex: 5,
				codec: "PGSSUB",
				language: null,
				displayTitle: null,
				isDefault: false,
				isForced: false,
				path: null,
				unavailable: true,
			},
		],
		userState: {
			positionTicks: 500,
			played: false,
			lastPlayedAt: "2026-01-02T00:00:00Z",
			pendingSync: false,
		},
		mediaSegments: null,
		item: {
			Id: "ep",
			Name: "Two",
			SeriesId: "s1",
			SeriesName: "Show",
			ParentIndexNumber: 1,
			IndexNumber: 2,
			RunTimeTicks: 1000,
			MediaSources: [
				{
					Id: "ms",
					DefaultSubtitleStreamIndex: 4,
					MediaStreams: [
						{ Type: "Video", Index: 0 },
						{ Type: "Audio", Index: 1 },
						{ Type: "Audio", Index: 2 },
						{ Type: "Subtitle", Index: 3, Codec: "subrip" },
						{ Type: "Subtitle", Index: 4, Codec: "ass" },
						{ Type: "Subtitle", Index: 5, Codec: "PGSSUB" },
					],
				},
			],
		},
	});

describe("local playback setup", () => {
	useDownloadsStore.setState({ mediaBaseUrl: "http://127.0.0.1:1/tok" });

	it("offers only downloaded subtitles, with absolute local URLs", () => {
		const subs = localSubtitleStreams(full());
		expect(subs.map((s) => [s.Index, s.Codec, s.DeliveryUrl])).toEqual([
			[3, "vtt", "http://127.0.0.1:1/tok/srv/ep/subs/3.vtt"],
			[4, "ass", "http://127.0.0.1:1/tok/srv/ep/subs/4.ass"],
		]);
	});

	it("fills the playback store like a stream", () => {
		const manifest = full();
		initializeLocalPlayback({ manifest, queue: [manifest], index: 0 });
		const args = vi.mocked(playItem).mock.calls.at(-1)?.[0];
		expect(args?.origin).toBe("local");
		expect(args?.localDownloadId).toBe("srv:ep");
		expect(args?.playbackStream).toBe(
			"http://127.0.0.1:1/tok/srv/ep/hls/index.m3u8",
		);
		expect(args?.playsessionId).toMatch(/^local-/);
		expect(args?.mediaSource.audio.allTracks?.map((t) => t.Index)).toEqual([2]);
		expect(args?.mediaSource.subtitle.track).toBe(4);
		expect(args?.mediaSource.subtitle.format).toBe("ass");
		expect(args?.metadata.itemName).toBe("Show");
		expect(args?.userDataPlayedPositionTicks).toBe(500);
	});

	it("starts from the more recent position", () => {
		const manifest = full();
		expect(startPositionFor(manifest)).toBe(500);
		expect(
			startPositionFor(manifest, {
				LastPlayedDate: "2026-02-01T00:00:00Z",
				PlaybackPositionTicks: 900,
			}),
		).toBe(900);
		expect(
			startPositionFor(manifest, {
				LastPlayedDate: "2025-12-01T00:00:00Z",
				PlaybackPositionTicks: 900,
			}),
		).toBe(500);
		expect(
			startPositionFor({
				...manifest,
				userState: { ...manifest.userState, played: true },
			}),
		).toBe(0);
	});
});

describe("playstate", () => {
	const prev = {
		positionTicks: 0,
		played: false,
		lastPlayedAt: null,
		pendingSync: false,
	};
	const now = new Date("2026-03-01T00:00:00Z");

	it("records position and flags it for sync", () => {
		expect(nextUserState(prev, "pause", 400, 1000, now)).toEqual({
			positionTicks: 400,
			played: false,
			lastPlayedAt: "2026-03-01T00:00:00.000Z",
			pendingSync: true,
		});
	});

	it("marks played at 90% or on end", () => {
		expect(nextUserState(prev, "progress", 900, 1000, now)).toMatchObject({
			played: true,
			positionTicks: 0,
		});
		expect(nextUserState(prev, "ended", 10, 1000, now)).toMatchObject({
			played: true,
			positionTicks: 0,
		});
		// Missing runtime: no 90% rule.
		expect(nextUserState(prev, "progress", 900, null, now)).toMatchObject({
			played: false,
			positionTicks: 900,
		});
	});
});

describe("resolveSync", () => {
	const local = {
		positionTicks: 400,
		played: false,
		lastPlayedAt: "2026-03-01T00:00:00Z",
		pendingSync: true,
	};

	it("pushes when the local change is newer", () => {
		expect(
			resolveSync(local, { LastPlayedDate: "2026-02-01T00:00:00Z" }),
		).toEqual({ action: "push" });
		expect(resolveSync(local, { LastPlayedDate: null })).toEqual({
			action: "push",
		});
	});

	it("keeps the server value when it is newer or equal", () => {
		expect(
			resolveSync(local, {
				LastPlayedDate: "2026-03-01T00:00:00Z",
				PlaybackPositionTicks: 7,
				Played: true,
			}),
		).toEqual({
			action: "keepServer",
			userState: {
				positionTicks: 7,
				played: true,
				lastPlayedAt: "2026-03-01T00:00:00Z",
				pendingSync: false,
			},
		});
	});
});
