import type { Api } from "@jellyfin/sdk";
import { PlayMethod } from "@jellyfin/sdk/lib/generated-client";
import { getItemsApi } from "@jellyfin/sdk/lib/utils/api/items-api";
import { getPlaystateApi } from "@jellyfin/sdk/lib/utils/api/playstate-api";
import { getUserLibraryApi } from "@jellyfin/sdk/lib/utils/api/user-library-api";
import type { QueryClient } from "@tanstack/react-query";
import { useDownloadsStore } from "./store";
import type { DownloadManifest, DownloadUserState } from "./types";

const isNotFound = (e: unknown) =>
	(e as { response?: { status?: number } })?.response?.status === 404;

const time = (iso: string | null | undefined) =>
	iso ? Date.parse(iso) || 0 : 0;

/**
 * What to do with one pending manifest given the server's UserData (last write wins on
 * timestamp). Exported for tests.
 */
export function resolveSync(
	local: DownloadUserState,
	server:
		| {
				LastPlayedDate?: string | null;
				PlaybackPositionTicks?: number;
				Played?: boolean;
		  }
		| null
		| undefined,
): { action: "keepServer"; userState: DownloadUserState } | { action: "push" } {
	if (server && time(server.LastPlayedDate) >= time(local.lastPlayedAt)) {
		return {
			action: "keepServer",
			userState: {
				positionTicks: server.PlaybackPositionTicks ?? 0,
				played: !!server.Played,
				lastPlayedAt: server.LastPlayedDate ?? local.lastPlayedAt,
				pendingSync: false,
			},
		};
	}
	return { action: "push" };
}

async function pushPosition(api: Api, userId: string, m: DownloadManifest) {
	const { positionTicks, lastPlayedAt } = m.userState;
	try {
		await getItemsApi(api).updateItemUserData({
			itemId: m.itemId,
			userId,
			updateUserItemDataDto: {
				PlaybackPositionTicks: positionTicks,
				LastPlayedDate: lastPlayedAt,
				Played: false,
			},
		});
	} catch (e) {
		if (!isNotFound(e)) throw e;
		// Older servers (10.8) don't have /UserItems/{id}/UserData: fake a short session.
		const common = {
			ItemId: m.itemId,
			MediaSourceId: m.mediaSourceId,
			PlaySessionId: null,
		};
		await getPlaystateApi(api).reportPlaybackStart({
			playbackStartInfo: {
				...common,
				PlayMethod: PlayMethod.DirectPlay,
				PositionTicks: positionTicks,
			},
		});
		await getPlaystateApi(api).reportPlaybackStopped({
			playbackStopInfo: { ...common, PositionTicks: positionTicks },
		});
	}
}

/**
 * Push watch progress recorded offline for this server+user. Runs sequentially; any error
 * leaves `pendingSync` set for the next attempt.
 */
export async function flushPendingPlaystate(
	api: Api,
	serverId: string,
	userId: string,
	queryClient?: QueryClient,
): Promise<number> {
	const store = useDownloadsStore.getState();
	const pending = Object.values(store.items).filter(
		(m) =>
			m.userState.pendingSync && m.serverId === serverId && m.userId === userId,
	);
	let synced = 0;
	for (const m of pending) {
		try {
			let serverUserData: Parameters<typeof resolveSync>[1];
			try {
				serverUserData = (
					await getUserLibraryApi(api).getItem({ itemId: m.itemId, userId })
				).data.UserData;
			} catch (e) {
				if (isNotFound(e)) {
					// The item is gone from the server; nothing to sync.
					await store.updateUserState(m.id, {
						...m.userState,
						pendingSync: false,
					});
					continue;
				}
				throw e;
			}
			const decision = resolveSync(m.userState, serverUserData);
			if (decision.action === "keepServer") {
				await store.updateUserState(m.id, decision.userState);
			} else {
				if (m.userState.played) {
					await getPlaystateApi(api).markPlayedItem({
						itemId: m.itemId,
						userId,
						datePlayed: m.userState.lastPlayedAt ?? undefined,
					});
				} else {
					await pushPosition(api, userId, m);
				}
				await store.updateUserState(m.id, {
					...m.userState,
					pendingSync: false,
				});
			}
			synced++;
			queryClient?.invalidateQueries({ queryKey: ["item", m.itemId] });
		} catch (error) {
			console.warn(`Could not sync watch progress for ${m.id}`, error);
		}
	}
	return synced;
}
