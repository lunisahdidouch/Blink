import {
	type BaseItemDto,
	LocationType,
} from "@jellyfin/sdk/lib/generated-client";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import { useMutation } from "@tanstack/react-query";
import { useSnackbar } from "notistack";
import React from "react";
import { DOWNLOAD_NOT_ALLOWED_MESSAGE } from "@/utils/constants/downloads";
import { describeDownloadError } from "@/utils/downloads/format";
import { useDownloadSettings, usePlanContext } from "@/utils/downloads/hooks";
import { canDownload, planDownload } from "@/utils/downloads/plan";
import { useDownloadsStore } from "@/utils/downloads/store";
import { downloadId } from "@/utils/downloads/types";
import { useCentralStore } from "@/utils/store/central";

/**
 * Queue every episode of a season that isn't virtual or already downloaded, using the
 * default quality (no dialog). Planning runs one episode at a time; the Rust queue then
 * downloads them one after another.
 */
const DownloadSeasonButton = ({
	episodes,
	seasonName,
}: {
	episodes: BaseItemDto[] | null | undefined;
	seasonName?: string | null;
}) => {
	const user = useCentralStore((s) => s.currentUser);
	const ctx = usePlanContext();
	const settings = useDownloadSettings();
	const { enqueueSnackbar } = useSnackbar();

	const mutation = useMutation({
		mutationFn: async () => {
			if (!ctx) throw new Error("Not connected to the server");
			const { items, enqueue } = useDownloadsStore.getState();
			const todo = (episodes ?? []).filter(
				(e) =>
					e.Id &&
					e.LocationType !== LocationType.Virtual &&
					!items[downloadId(ctx.server.id, e.Id)],
			);
			let queued = 0;
			const failures: string[] = [];
			for (const episode of todo) {
				try {
					const planned = await planDownload(ctx, episode, {
						quality: settings.data?.defaultQuality ?? "auto",
					});
					await enqueue(planned.job);
					queued++;
				} catch (e) {
					failures.push(`${episode.Name}: ${describeDownloadError(e)}`);
				}
			}
			return { queued, failures };
		},
		onSuccess: ({ queued, failures }) => {
			enqueueSnackbar(
				queued === 0 && failures.length === 0
					? "Everything in this season is already downloaded"
					: `Queued ${queued} episode${queued === 1 ? "" : "s"}`,
				{ variant: queued > 0 ? "success" : "info" },
			);
			for (const f of failures.slice(0, 3))
				enqueueSnackbar(f, { variant: "error" });
		},
		onError: (e) =>
			enqueueSnackbar(describeDownloadError(e), { variant: "error" }),
	});

	const allowed = canDownload(user);
	const title = allowed
		? `Download ${seasonName ?? "season"}`
		: DOWNLOAD_NOT_ALLOWED_MESSAGE;

	return (
		<Tooltip title={title}>
			<span>
				<IconButton
					onClick={() => mutation.mutate()}
					disabled={!allowed || mutation.isPending || !episodes?.length}
					aria-label={title}
				>
					{mutation.isPending ? (
						<CircularProgress size={22} />
					) : (
						<span className="material-symbols-rounded">
							{allowed ? "download" : "file_download_off"}
						</span>
					)}
				</IconButton>
			</span>
		</Tooltip>
	);
};

export default DownloadSeasonButton;
