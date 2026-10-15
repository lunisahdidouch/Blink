import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import playbackProfile from "@/utils/playback-profiles";
import { getDownloadSettings } from "@/utils/storage/downloads";
import {
	getDefaultServer,
	getServer,
	type ServerInfo,
} from "@/utils/storage/servers";
import { useApiInContext } from "@/utils/store/api";
import { useCentralStore } from "@/utils/store/central";
import { type PlanContext, replanForResume } from "./plan";
import type { Replanner } from "./store";

export const serverDisplayName = (s: ServerInfo | null | undefined) =>
	s?.systemInfo?.ServerName ?? s?.address ?? "Jellyfin";

/** The default server from storage (its id namespaces downloads). */
export const useCurrentServer = () =>
	useQuery({
		queryKey: ["downloads", "currentServer"],
		queryFn: async () => {
			const id = await getDefaultServer();
			return (await getServer(id)) ?? null;
		},
		networkMode: "always",
		staleTime: 30_000,
	});

export const DOWNLOAD_SETTINGS_QUERY_KEY = ["downloads", "settings"];

export const useDownloadSettings = () =>
	useQuery({
		queryKey: DOWNLOAD_SETTINGS_QUERY_KEY,
		queryFn: getDownloadSettings,
		networkMode: "always",
		staleTime: Number.POSITIVE_INFINITY,
	});

/** Everything `planDownload` needs; null while signed out or loading. */
export const usePlanContext = (): PlanContext | null => {
	const api = useApiInContext((s) => s.api);
	const user = useCentralStore((s) => s.currentUser);
	const server = useCurrentServer();
	return useMemo(() => {
		if (!api?.accessToken || !user?.Id || !server.data) return null;
		return {
			api,
			user,
			server: {
				id: server.data.id,
				name: serverDisplayName(server.data),
				address: api.basePath,
			},
			deviceProfile: playbackProfile,
		};
	}, [api, user, server.data]);
};

/** A replanner only works for downloads from the server we're signed in to. */
export const replannerFor = (
	ctx: PlanContext | null,
	serverId: string,
): Replanner | null => {
	if (!ctx || ctx.server.id !== serverId) return null;
	return (m) => replanForResume(ctx, m);
};
