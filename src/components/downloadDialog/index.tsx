import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client";
import { getUserLibraryApi } from "@jellyfin/sdk/lib/utils/api/user-library-api";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useSnackbar } from "notistack";
import React, { useEffect, useMemo, useState } from "react";
import {
	DOWNLOAD_ORIGINAL_MAX_BITRATE,
	DOWNLOAD_QUALITY_BITRATES,
	DOWNLOAD_QUALITY_OPTIONS,
	DOWNLOAD_SPACE_MARGIN_BYTES,
} from "@/utils/constants/downloads";
import { downloadsFreeSpace } from "@/utils/downloads/commands";
import { describeDownloadError, formatBytes } from "@/utils/downloads/format";
import { useDownloadSettings, usePlanContext } from "@/utils/downloads/hooks";
import {
	estimateBytes,
	type PlannedDownload,
	planDownload,
} from "@/utils/downloads/plan";
import { useDownloadsStore } from "@/utils/downloads/store";
import type { DownloadQuality } from "@/utils/downloads/types";
import { pickAudio } from "@/utils/methods/trackSelection";

type DownloadDialogProps = {
	open: boolean;
	onClose: () => void;
	item: BaseItemDto;
	/** Audio track selected on the item page, used as the default. */
	defaultAudioTrack?: number | "auto";
};

const DownloadDialog = ({
	open,
	onClose,
	item,
	defaultAudioTrack,
}: DownloadDialogProps) => {
	const ctx = usePlanContext();
	const settings = useDownloadSettings();
	const enqueue = useDownloadsStore((s) => s.enqueue);
	const { enqueueSnackbar } = useSnackbar();

	// Items from list views often lack MediaSources/MediaStreams.
	const fullItem = useQuery({
		queryKey: ["downloads", "dialogItem", item.Id],
		queryFn: async () => {
			if (!ctx || !item.Id) return item;
			return (
				await getUserLibraryApi(ctx.api).getItem({
					itemId: item.Id,
					userId: ctx.user.Id,
				})
			).data;
		},
		enabled: open && !!ctx && !!item.Id,
		initialData: item.MediaSources?.[0]?.MediaStreams ? item : undefined,
	});

	const freeSpace = useQuery({
		queryKey: ["downloads", "freeSpace"],
		queryFn: downloadsFreeSpace,
		enabled: open,
		networkMode: "always",
	});

	const sources = fullItem.data?.MediaSources ?? [];
	const [sourceId, setSourceId] = useState<string | undefined>();
	const source = sources.find((s) => s.Id === sourceId) ?? sources[0];
	const audioTracks =
		source?.MediaStreams?.filter((s) => s.Type === "Audio") ?? [];
	const [audioIndex, setAudioIndex] = useState<number | undefined>();
	const [quality, setQuality] = useState<DownloadQuality>("auto");
	const [pendingWarning, setPendingWarning] = useState<PlannedDownload | null>(
		null,
	);

	useEffect(() => {
		if (open) {
			setQuality(settings.data?.defaultQuality ?? "auto");
			setPendingWarning(null);
			setSourceId(undefined);
			setAudioIndex(undefined);
		}
	}, [open, settings.data?.defaultQuality]);

	// A changed choice needs a fresh plan (and possibly no warning).
	useEffect(() => setPendingWarning(null), [quality, sourceId, audioIndex]);

	const effectiveAudio = useMemo(() => {
		if (!source) return undefined;
		if (audioIndex !== undefined) return audioIndex;
		const requested =
			typeof defaultAudioTrack === "number" &&
			audioTracks.some((t) => t.Index === defaultAudioTrack)
				? defaultAudioTrack
				: undefined;
		return pickAudio(source, ctx?.user.Configuration, requested);
	}, [
		source,
		audioIndex,
		defaultAudioTrack,
		audioTracks,
		ctx?.user.Configuration,
	]);

	const estimate = useMemo(() => {
		if (!source) return null;
		const fixed =
			quality === "high" || quality === "medium" || quality === "low";
		return estimateBytes(
			fixed ? "hls" : "file",
			source,
			fullItem.data?.RunTimeTicks,
			fixed
				? DOWNLOAD_QUALITY_BITRATES[quality]
				: DOWNLOAD_ORIGINAL_MAX_BITRATE,
		);
	}, [source, quality, fullItem.data?.RunTimeTicks]);

	const notEnoughSpace =
		estimate !== null &&
		freeSpace.data !== undefined &&
		freeSpace.data < estimate * 1.05 + DOWNLOAD_SPACE_MARGIN_BYTES;

	const submit = useMutation({
		mutationFn: async (confirmed: PlannedDownload | null) => {
			if (confirmed) {
				await enqueue(confirmed.job);
				return "queued" as const;
			}
			if (!ctx || !fullItem.data)
				throw new Error("Not connected to the server");
			const planned = await planDownload(ctx, fullItem.data, {
				mediaSourceId: source?.Id,
				audioStreamIndex: effectiveAudio,
				quality,
			});
			if (planned.mayNotPlay) {
				setPendingWarning(planned);
				return "warn" as const;
			}
			await enqueue(planned.job);
			return "queued" as const;
		},
		onSuccess: (result) => {
			if (result === "queued") {
				enqueueSnackbar(`Downloading "${item.Name}"`, { variant: "success" });
				onClose();
			}
		},
		onError: (e) =>
			enqueueSnackbar(describeDownloadError(e), { variant: "error" }),
	});

	return (
		<Dialog
			open={open}
			onClose={onClose}
			fullWidth
			maxWidth="xs"
			slotProps={{ paper: { className: "glass" } }}
			onClick={(e) => e.stopPropagation()}
		>
			<DialogTitle>Download "{item.Name}"</DialogTitle>
			<DialogContent
				style={{
					display: "flex",
					flexDirection: "column",
					gap: "1.2em",
					paddingTop: "0.6em",
				}}
			>
				{fullItem.isPending && !fullItem.data ? (
					<CircularProgress style={{ alignSelf: "center" }} />
				) : (
					<>
						{sources.length > 1 && (
							<TextField
								select
								label="Version"
								value={source?.Id ?? ""}
								onChange={(e) => {
									setSourceId(e.target.value);
									setAudioIndex(undefined);
								}}
							>
								{sources.map((s) => (
									<MenuItem key={s.Id} value={s.Id ?? ""}>
										{s.Name ?? s.Container}
									</MenuItem>
								))}
							</TextField>
						)}
						{audioTracks.length > 0 && (
							<TextField
								select
								label="Audio track"
								value={effectiveAudio ?? ""}
								onChange={(e) => setAudioIndex(Number(e.target.value))}
								helperText={
									audioTracks.length > 1
										? "The audio track can't be changed during offline playback."
										: undefined
								}
							>
								{audioTracks.map((t) => (
									<MenuItem key={t.Index} value={t.Index}>
										{t.DisplayTitle ?? t.Language ?? `Track ${t.Index}`}
									</MenuItem>
								))}
							</TextField>
						)}
						<TextField
							select
							label="Quality"
							value={quality}
							onChange={(e) => setQuality(e.target.value as DownloadQuality)}
							helperText={
								quality === "auto"
									? "Keeps the original file when Blink can play it, otherwise downloads a compatible copy."
									: quality === "original"
										? "Always keeps the original file, even if Blink can't play it."
										: "The server makes a smaller, compatible copy."
							}
						>
							{DOWNLOAD_QUALITY_OPTIONS.map((q) => (
								<MenuItem key={q.value} value={q.value}>
									{q.label}
								</MenuItem>
							))}
						</TextField>
						<div
							className="flex flex-row"
							style={{ justifyContent: "space-between" }}
						>
							<Typography variant="body2" style={{ opacity: 0.8 }}>
								Estimated size:{" "}
								{estimate !== null ? `~${formatBytes(estimate)}` : "unknown"}
							</Typography>
							<Typography variant="body2" style={{ opacity: 0.8 }}>
								Free: {freeSpace.isSuccess ? formatBytes(freeSpace.data) : "…"}
							</Typography>
						</div>
						{notEnoughSpace && (
							<Alert severity="error">
								There isn't enough free space for this download.
							</Alert>
						)}
						{pendingWarning && (
							<Alert severity="warning">
								Blink probably can't play this file as-is. Choose Auto or a
								lower quality for a compatible copy, or download the original
								anyway.
							</Alert>
						)}
					</>
				)}
			</DialogContent>
			<DialogActions>
				<Button onClick={onClose}>Cancel</Button>
				<Button
					variant="contained"
					loading={submit.isPending}
					disabled={!ctx || !source || notEnoughSpace}
					onClick={() => submit.mutate(pendingWarning)}
				>
					{pendingWarning ? "Download anyway" : "Download"}
				</Button>
			</DialogActions>
		</Dialog>
	);
};

export default DownloadDialog;
