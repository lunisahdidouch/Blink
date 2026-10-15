import { describe, expect, it, vi } from "vitest";

const playback = { origin: "local", localDownloadId: "srv:ep" };
vi.mock("@/utils/store/playback", () => ({
	usePlaybackStore: { getState: () => playback },
}));
vi.mock("@/utils/storage/servers", () => ({
	getDefaultServer: async () => "srv",
}));
vi.mock("@/utils/storage/user", () => ({ getUser: async () => ({ Id: "u" }) }));

let serverDelays: number[] = [];
vi.mock("@jellyfin/sdk/lib/utils/api/playstate-api", () => {
	const slow = async () => {
		const delay = serverDelays.shift() ?? 0;
		await new Promise((r) => setTimeout(r, delay));
		throw new Error("offline");
	};
	return {
		getPlaystateApi: () => ({
			reportPlaybackStart: slow,
			reportPlaybackProgress: slow,
			reportPlaybackStopped: slow,
		}),
	};
});

import { reportPlaystate } from "./playstate";
import { useDownloadsStore } from "./store";
import type { DownloadManifest, DownloadUserState } from "./types";

describe("local playstate saves", () => {
	it("keep the latest position when an earlier server report is slow", async () => {
		const writes: DownloadUserState[] = [];
		const manifest = {
			id: "srv:ep",
			serverId: "srv",
			userId: "u",
			itemId: "ep",
			mediaSourceId: "ep",
			media: { audioStreamIndex: 1 },
			item: { RunTimeTicks: 1_200_000_000 },
			userState: {
				positionTicks: 0,
				played: false,
				lastPlayedAt: null,
				pendingSync: false,
			},
		} as unknown as DownloadManifest;
		useDownloadsStore.setState({
			items: { "srv:ep": manifest },
			updateUserState: async (id: string, userState: DownloadUserState) => {
				writes.push(userState);
				useDownloadsStore.setState((s) => {
					s.items[id] = { ...s.items[id], userState };
				});
			},
		});
		const api = { accessToken: "t" } as never;
		// First report hangs for a while (offline server), the second fails fast.
		serverDelays = [200, 0];
		const first = reportPlaystate("progress", api, 0);
		await new Promise((r) => setTimeout(r, 10));
		const second = reportPlaystate("stop", api, 618_000_000);
		await Promise.all([first, second]);
		const final = useDownloadsStore.getState().items["srv:ep"].userState;
		expect(final.positionTicks).toBe(618_000_000);
		expect(final.pendingSync).toBe(true);
		expect(writes.map((w) => w.positionTicks)).toEqual([0, 618_000_000]);
	});
});
